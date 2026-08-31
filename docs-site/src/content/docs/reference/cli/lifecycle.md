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
The web dashboard's **Stop** button runs the same action (`POST /api/stop`) on every backend
except Windows Task Scheduler. There the wrapper can respawn the proxy after the task ends,
and only a stop running outside the proxy can verify that restart window before restoring
your client config — so the dashboard refuses with `respawnable_service`, changes nothing,
and asks you to run `ocx stop`.

### `ocx restart`

When a proxy is running, ask that exact attested PID and port to restart in place, wait for its
normal drain, and verify a different runtime PID on the same port. Managed routing and service
supervision stay installed throughout; an uncertain request is observed rather than replayed as a
separate stop/start. If no proxy is running, the command falls back to the normal `ensure` start.
If a live listener cannot be attested to a runtime PID (including a pre-update proxy), restart fails
closed without an `ensure` or stop/start fallback. After confirming ownership, use `ocx stop` then
`ocx start` for a standalone proxy. For a service-managed proxy, use `ocx stop` followed by
`ocx service start` so supervision is restored.

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

### `ocx recover-history --legacy-openai --yes`

Explicit recovery for older development builds that remapped Codex App history before reversible
backup support existed. Close Codex first if its history database is locked.

This is a broad, destructive relabel: every user-message thread currently tagged `opencodex` is
changed to `openai`, `exec` is normalized to `cli`, and the event marker is set. That includes
legitimate dedicated-provider history. Back up the state and run it only when that full scope is
intended.

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

### `ocx ready [--json] [--wait [--timeout <seconds>]]`

Check post-sync readiness through the unauthenticated `GET /readyz` endpoint. It returns `200` when
ready, or `503` with `Retry-After: 1` for `pending` and terminal `failed`. Its sanitized HTTP identity
is `{service, version, uptime, pid, port, status}`. Old proxies without `/readyz` fail closed as
`unreachable`; `/healthz` is separate liveness, not readiness. The command performs one probe by
default; `--wait` polls until ready or timeout, but exits immediately when it observes the terminal `failed` state. The
default timeout is 45 seconds; `--timeout <seconds>` requires `--wait` and accepts positive integer seconds from 1–300.
CLI JSON emits `{ready, status, pid, port}`, where `status` is `ready`, `pending`, `failed`, or
`unreachable`. Exit codes are 0 for ready; 1 for not-ready, pending, failed, timeout, or
unreachable; and 64 for invalid arguments.

### `ocx doctor`

The default report includes the native-write coordinator state and exact path using immutable
read-only SQLite inspection. Zero-byte, empty-unversioned, and rowless states are shown separately
from catalog/app-server health, so a successful catalog refresh is not mistaken for successful
Codex config injection.

After stopping the OpenCodex proxy/service, explicitly preserve and move a proven non-authoritative
coordinator, then retry sync:

```bash
ocx doctor --recover-zero-byte-coordinator --yes
ocx sync
```

The recovery accepts only a proven zero-byte remnant. It refuses every non-empty, valid, unknown,
changed, unsafe, or busy database and creates a same-directory `.zero-byte-backup-*` file instead
of deleting anything.

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

Before provider discovery or catalog/cache replacement, `ocx sync` validates that the managed
Codex configuration can be injected. If that validation refuses the config, the command exits
nonzero, prints the concrete reason on stderr, and leaves the existing catalog and cache unchanged.
`ocx restore back` uses the same no-write preflight before it re-enables routing.

If long-lived Codex `app-server` processes are still running, `ocx sync` warns that they may keep
serving the previous in-memory model list even though `opencodex-catalog.json` / `models_cache.json`
were updated. Pass `--restart-codex` to send `SIGTERM` only to matching `codex … app-server` and
`codex-code-mode-host` processes owned by the current user (active turns may be interrupted). Broad
`pkill -f codex` matching is intentionally avoided.

### `ocx sync-cache [--restart-codex]`

Invalidate Codex's local model picker cache so it is rebuilt from the active opencodex catalog. The
same stale-`app-server` warning and optional `--restart-codex` behavior as `ocx sync` apply.

## Background service

### `ocx service [install|repair|restart|start|stop|status|uninstall|remove]`

Run opencodex as a login-managed background service (macOS **launchd**, Linux **systemd user unit**,
Windows **Task Scheduler**) that auto-starts on login and auto-restarts on crash. Service runs set
`OCX_SERVICE=1` so a restart does not churn the Codex config.

The Windows wrapper verifies its baked Bun runtime and CLI entry before every start attempt. If an
interrupted package update removed either file, it logs one `installation is incomplete` message and
stops instead of retrying the same missing executable every five seconds. Reinstall opencodex, then
run `ocx service repair` to refresh the task with the restored package paths.

On Linux, the systemd unit invokes the first regular, executable `ocx` file found on `PATH` at
install time rather than the Bun and CLI paths inside the installed package tree. Version managers such as
**mise** and **asdf** install into a versioned directory and delete the old one on upgrade, which
used to leave the unit pointing at files that no longer existed — systemd then restart-looped while
still reporting the service as installed. A shim path survives the upgrade, so the unit keeps
resolving. Source checkouts without an `ocx` launcher keep the previous direct Bun + CLI form. A
trusted `OPENCODEX_BUN_PATH` selected before Bun starts is preserved through the shim; package-local
bundled Bun paths are deliberately rediscovered after upgrades instead of being pinned in the unit.

Units installed before this change still carry the old versioned paths and cannot migrate
themselves — once the old executable is deleted, no opencodex code runs to fix it. Run
`ocx service repair` once after upgrading; subsequent version changes need no action.

| Subcommand | Action |
| --- | --- |
| none | Install and start when absent; otherwise refresh and restart the existing service. A healthy Windows scheduler definition is reused; a stale definition may be re-registered and require elevation. |
| `install` | Create and start the service. Registers it, which on Windows needs elevation. |
| `repair` | Refresh an installed service in place and restart it. A healthy Windows scheduler definition is reused; a stale definition may be re-registered and require elevation. |
| `restart` | Alias of `repair`. |
| `start` | Start an installed service. |
| `stop` | Stop the service and restore native Codex. |
| `status` | Report service and proxy diagnostics plus log paths. |
| `uninstall` | Remove the service and restore native Codex. |
| `remove` | Alias of `uninstall`. |

On Windows, a bare `ocx service` runs the install path only after both Task Scheduler and WinSW are
proven absent. If either status query is inconclusive, it refuses to register anything and asks you
to run `ocx service status`; use explicit `ocx service install` only after confirming absence.

```bash
ocx service
ocx service install
ocx service repair
ocx service restart
ocx service status
ocx service uninstall
```

`install`, `start`, and `repair` confirm that a proxy actually answers on the port
baked into the installed service before reporting success — on all three platforms.
They wait up to 20 seconds and then print the serving port:

```
✅ opencodex service installed and serving on port 10100.
```

If nothing answers, they warn and **exit non-zero**:

```
⚠️  Service installed, but no proxy answered on port 10100 within 20s.
   The manager registered the job; that is not the same as serving.
   Log:       ~/.opencodex/service.log
   Meanwhile: ocx start   (serves in the foreground)
```

A non-zero exit here means *registered but not serving* — not *not installed*. The
service manager accepted the job; the proxy behind it never bound the port. Read the
log named in the message, and use `ocx start` to serve in the foreground meanwhile.

`ocx service status` reports the same three states rather than raw manager output:

```
✅ installed and loaded (launchd; logs: …)
   Serving on port 10100.
```

```
⚠️  installed and loaded (launchd; logs: …)
   Registered, but no proxy is answering on port 10100.
   launchd is running an OLDER plist than the one on disk.
   Fix:    launchctl bootout gui/$(id -u)/com.opencodex.proxy && ocx service repair
   Log:    ~/.opencodex/service.log
   Repair: ocx service repair
   Meanwhile: ocx start           (serves in the foreground)
```

It no longer prints the raw `launchctl list` / `systemctl status` line, which
reported a registered job identically whether it was serving, bound to nothing, or
running a previous definition. The `Diagnostics:` line still carries the log path and
any stale-baked-path finding.

On Windows the scheduler backend keeps its own richer status output, which already
reported Task Scheduler registration separately from proxy reachability.

On macOS this also covers a subtler failure: `launchctl load` reports failure on
stderr while exiting 0, so a load that did not take used to leave launchd running a
**previous** version of the service definition while the command printed a checkmark.
`install` now fails loudly in that case and names the `launchctl bootout` command that
clears the stale job.

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

For a fresh install where the OpenCodex scheduler task is confirmed absent, UAC approval now
happens before the installer stops any existing proxy. Its unique registration XML is staged in
an ACL-hardened private directory outside the OpenCodex config root, and the task is registered
without being run. Only after
registration succeeds does OpenCodex remove that XML, require ownership metadata for a genuinely
new config root, stop the old listener, remove and boundedly re-verify any native WinSW
registration, publish the service assets, and start the scheduled task. Cancelling or denying UAC,
or failing to claim a new root safely, therefore leaves the working proxy and its Codex routing in
place. Existing or conflicting scheduler registrations continue to fail closed rather than being
deleted as an unsafe best-effort rollback.

### `ocx codex-shim <install|status|uninstall|remove>`

Wrap a script-based `codex` launcher on PATH with a lightweight autostart script. Real `codex.exe`
targets are left untouched to avoid breaking exact executable invocations.

Before an install or repair is committed, OpenCodex runs the saved launcher with `--version` while
service startup is bypassed. It refuses the change and rolls back when the launcher resolves
`codex` back to the shim, exits nonzero, exceeds five seconds, leaves descendants running, or
cannot be validated and cleaned up safely. Therefore `codex-shim install` is not unconditional. If
it is refused, reinstall Codex so the PATH entry is a concrete executable or launcher and retry;
use `ocx service install` instead when a dynamic command-manager launcher cannot meet these checks.
During upgrades, an installed Unix shim that lacks the current validation guard is regenerated and
probed. If its saved launcher is unsafe, OpenCodex removes the obsolete shim and restores the
original launcher instead of leaving the unsafe wrapper installed.

Launcher installation alone does not prove that Codex requests will use OpenCodex. After a healthy
install, the command checks the current Codex routing and reports a warning instead of a green result
when routing is external, user-owned, or unverifiable. It also warns when outbound proxy variables
exist only in the current process while `config.proxy` is unset or unresolved, because Codex
launchers and background services may not inherit that environment. These checks are read-only and
never print proxy values; resolve the reported handoff and run `ocx doctor` before relying on
autostart.

If a completed external Codex update overwrites an installed shim, the next ordinary `ocx` command
backs up the stable new launcher and restores the shim before dispatch. The zero-effect
`ocx system codex-cli-update check` inspection command and malformed invocations in its reserved
`ocx system codex-cli-update` namespace never perform that repair.
A launcher that is still
changing is left untouched and retried later. Repair failures warn without failing the requested
command; manual fallback: `ocx codex-shim install`. Set `codexShimAutoRestore` to `false`, or set
`OPENCODEX_CODEX_SHIM_AUTO_RESTORE=0` for a process-level opt-out.

That restore needs the original launcher OpenCodex saved next to the shim. A version manager —
mise, asdf, volta — rewrites its whole install tree on upgrade, which destroys the shim *and* that
backup, so there is nothing left to restore from. **A version-manager install tree is not a
supported shim target.** OpenCodex reports the condition and stops rather than wrapping the newly
installed binary as a replacement original: doing so would record a history that never happened, and
the next upgrade would overwrite it again, so the repair would silently undo itself on the version
manager's schedule.

If your `codex` is owned by a version manager, route through Codex configuration instead of the
launcher: `ocx start` writes `openai_base_url`, and `ocx service install` provides autostart. Run
`ocx status` to confirm — it reports the active routing, and warns when a running proxy is not the
one Codex is pointed at.

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

`ocx update` updates OpenCodex itself; it does not update the Codex CLI. Use the
[system inspection commands](/reference/cli/agents/) to inspect the configured Codex CLI candidate
with bounded, read-only provenance inspection. `ocx system codex-cli-update check` does not query a
package registry or install an update.

### `ocx update [--tag latest|preview]`

Self-update opencodex from npm. Stable installs use `@latest`; preview installs stay on `@preview`
unless you pass `--tag latest|preview`. It detects a source checkout and tells you to
`git pull && bun install` instead, and is a no-op if you are already on the newest version for that
tag. Before stopping anything, npm installations run a bounded Unix cache ownership and access
check. Nested symlinks are checked with `lstat` but not followed; Windows explicitly skips this
Unix-only check. A failure aborts while the tray and proxy are still running. A running proxy is
then stopped before files are replaced; an installed service is rebuilt and started automatically,
while a foreground installation prints `ocx start` as the next step. Dashboard update records
redact profile/cache paths and UID/GID values before they are persisted.

```bash
ocx update
ocx update --tag preview
```

New versions become available when the [Release workflow](https://github.com/lidge-jun/opencodex/actions/workflows/release.yml)
publishes them to npm.
