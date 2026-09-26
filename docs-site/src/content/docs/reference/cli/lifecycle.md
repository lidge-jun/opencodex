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

### `ocx start [--port <port>] [--socks5 [host:port] | --socks5-off]`

Start the proxy server (preferred port `10100`). It writes PID/runtime-port state and refuses to
start a second live instance. When the preferred port is occupied, `start` asks the holder who it
is and stops either way: it refuses outright when an opencodex answers there, and reports an
unidentified holder otherwise. It never moves the listener to another port on its own, because that
would leave the first proxy running and re-point Codex at the second. An explicit different
`--port` is still refused when the live proxy shares this `OPENCODEX_HOME`, because observe-only
and enforced spend accounting both write the same journal. Use a separate `OPENCODEX_HOME` for an
independent sibling; `port: 0` only asks the OS for that instance's port and does not separate its
state. On start it syncs each provider's models into Codex's catalog. On shutdown it restores
native Codex — unless it was launched as a managed service (`OCX_SERVICE=1`). A sibling started
beside a running proxy does neither: it serves direct requests on its own port only, and Codex,
Grok and Claude stay pointed at the proxy that was already running. Stopping that sibling, with
`ocx stop` or a signal, leaves their configuration alone as well.

`--socks5` (default `127.0.0.1:10808`) saves `config.proxy` as a SOCKS5 URL and routes outbound
HTTP(S) through a real SOCKS5 tunnel. `--socks5-off` clears only that saved SOCKS5 proxy; it
does not remove an HTTP proxy. The value survives `ocx update` because it lives in config, not in
the installed package. A proxy username and password may be included in the URL, but startup
logs redact them.

```bash
ocx start
ocx start --port 8080
ocx start --port 10100 --socks5
ocx start --socks5-off
```

### `ocx stop [--json]`

Stop the running proxy (by PID), remove the PID file, and restore native Codex. If a managed
background service is installed, `ocx stop` also stops it first so it cannot respawn the proxy.
The web dashboard's **Stop** button runs the same action (`POST /api/stop`) on every backend
except Windows Task Scheduler. There the wrapper can respawn the proxy after the task ends,
and only a stop running outside the proxy can verify that restart window before restoring
your client config — so the dashboard refuses with `respawnable_service`, changes nothing,
and asks you to run `ocx stop`.

The dashboard also refuses when the proxy is running *as* the installed launchd or systemd
service. Stopping that manager from inside the proxy would terminate the process before
native Codex is restored, leaving your client config pointed at a proxy that is gone, so the
dashboard returns `self_unload_service`, changes nothing, and asks you to run `ocx stop` —
which stops the service from outside and completes the restore.

A proxy exit alone does not confirm that shared Codex/Grok restoration succeeded. If the stop
response reports failure, is unreadable, or does not confirm the assigned teardown mode, the CLI
keeps restoration with the stopping parent after the existing ownership and respawn checks.
It does not enter the forced-stop fallback for a process already observed to have exited. A
receipt-backed deferral still leaves final restoration and receipt cleanup with the parent;
failure to restore shared client configuration keeps the stop failed and its receipt outstanding.

`ocx stop --json` runs exactly the same stop path and prints one versioned summary document
(`schema: "ocx-stop/1"`) on stdout, while the human progress lines move to stderr. The summary
carries the outcome class (`stopped`, `not-running`, `history-incomplete`, `history-deferred`,
or `failed`), the service and proxy classifications, whether the runtime is down, and a stable
one-line message. Exit codes are identical with and without `--json`: 0 on success, 1 on failure,
79 when only Codex history cleanup did not complete, and 80 when the shared teardown was deferred
and is still owed.

### `ocx restart`

When a proxy is running, ask that exact attested PID and port to restart in place, wait for its
normal drain, and verify a different runtime PID on the same port. Managed routing and service
supervision stay installed throughout; an uncertain request is observed rather than replayed as a
separate stop/start. If no proxy is running, the command falls back to the normal `ensure` start.
If a live listener cannot be attested to a runtime PID (including a pre-update proxy), restart fails
closed without an `ensure` or stop/start fallback. After confirming ownership, use `ocx stop` then
`ocx start` for a standalone proxy. For a service-managed proxy, use `ocx stop` followed by
`ocx service start` so supervision is restored.

Port recovery after stop or update respects a failed OCX process check even when the PID was
recorded before shutdown. A rejected live holder is left running and prevents TCP-row cleanup.
If it stays unverified, the bounded recovery wait can expire with the port still busy. Check the
current port holder and retry the restart after the conflict is resolved.

### `ocx ensure`

Idempotently ensure a background proxy is running, then sync its live model catalog. If
`codexAutoStart` is `false`, it prints that autostart is disabled and does nothing.

### `ocx restore [back]` · `ocx eject [back]`

Restore native Codex **without** stopping the proxy — strips the injected config lines and routed
catalog entries so plain `codex` works natively again. `eject` is an alias of `restore`.

Restored catalog output excludes retired native models, including `gpt-5.3-codex-spark`,
whether stored as bare ids or trusted account-qualified rows. This applies with or without
a catalog backup; the original backup and historical user-selected configuration are preserved.

Restoration reports failure instead of replacing changed configuration files when a saved journal
lacks the corresponding injection hashes. The current files and journal remain available for
review; see [recovery without injection hashes](/guides/codex-integration/#recovery-without-injection-hashes).

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

### `ocx recover-history --ocx-compaction <thread-id> --yes`

Repair one thread that was compacted through a routed provider before resuming it through native
Codex. The command reads the exact thread selected by UUID, saves a private byte-for-byte backup,
then converts only OpenCodeX-owned `ocx1:` compaction state into a plain summary that native Codex
can replay. Native encrypted content and other threads are left unchanged. Close the selected
thread before running the command; a concurrent rollout change makes recovery stop without
replacing the file.

### `ocx uninstall` · `ocx remove`

Stop the service and proxy, remove the service and Codex shim, restore native Codex, then remove
opencodex local config only if all restore steps succeeded. `remove` is an alias of `uninstall`.
Config cleanup requires ownership metadata created by a fresh install; legacy or shared directories
are left in place.

## Status and health

### `ocx status [--json]`

Status and `ocx doctor` compare this CLI's version with the running proxy. If the CLI is newer,
restart the proxy using the intended current installation; for a background service, run
`ocx service restart`. On macOS, a version skew leaves the service definition byte-identical, so
`ocx service repair` would reload nothing and keep the old process serving. If the proxy is newer, upgrade the CLI
or resolve `PATH` to the intended installation. These diagnostics do not repair the service or
change whether requests are allowed.

Identical version strings and the `unknown` / `0.0.0` placeholders suppress the warning, as does
an absent proxy version. Doctor does not report placeholders as a confirmed match. Different
strings still produce a neutral warning when they cannot be strictly parsed as SemVer or differ
only in build metadata; neither side is called older. Versions are not trimmed and a leading `v`
is not normalized. JSON exposes the same advice in `versionSkew`, whose fields remain
`cliVersion`, `proxyVersion`, `skewed`, and `warning`.

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
is `{service, version, uptime, pid, port, status}` plus the remote-hub protocol fields
`{protocol, minimumClientProtocol, managementUrl}`. `protocol` is the hub protocol this proxy
speaks and `minimumClientProtocol` the oldest client it still accepts, so a client can refuse an
incompatible pairing before sending anything else. `managementUrl` is the origin a client should
use for the management plane: the configured `hub.managementPublicOrigin` when `runtimeRole` is
`hub`, and otherwise the origin the request itself arrived on. A readiness request with no
HTTP(S) origin is rejected rather than answered with a guess. Old proxies without `/readyz` fail
closed as `unreachable`; `/healthz` is separate liveness, not readiness. The command performs one probe by
default; `--wait` polls until ready or timeout, but exits immediately when it observes the terminal `failed` state. The
default timeout is 45 seconds; `--timeout <seconds>` requires `--wait` and accepts positive integer seconds from 1–300.
The CLI's own `--json` output is deliberately narrower than the HTTP body: it emits
`{ready, status, pid, port}`, where `status` is `ready`, `pending`, `failed`, or
`unreachable`. Exit codes are 0 for ready; 1 for not-ready, pending, failed, timeout, or
unreachable; and 64 for invalid arguments.

### `ocx resolve [--json]`

Resolve the runtime facts a shell needs without re-implementing them: the config home, the
effective port, and the identity-checked liveness verdict. `--json` emits one versioned
document (`schema: "ocx-resolve/1"`) with `cliVersion`, `configHome`, `port`
(`effective`, `configured`, and `source`), and `liveness` (`status`, `pid`, `port`,
`source`, plus `version`, `role`, and `hostname` when the live proxy reports them).
Liveness has three answers: `live`, `absent-proven` (every recorded and configured endpoint
definitively refused or answered non-opencodex), and unknown — a timed-out probe or a listener
that withholds `/healthz` exits 1 rather than reading as absent, so only `absent-proven` may
authorise starting a new runtime. The port is the live listener's port when a proxy answers,
otherwise the configured port (default 10100). Exit 0 carries a trustworthy verdict; exit 1 means
the CLI could not resolve — including an invalid `config.json`, which is never repaired to
defaults here — and the caller must refuse to guess; any unknown argument exits 64. Discovery uses
the same ownership-safe probe budget as `ocx start`, because a false "nothing listening" answer
is how duplicate proxies happen. The verb is read-only and skips the shim auto-restore preflight.

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

Project-config diagnostics ignore provider examples inside TOML multiline strings, including
`developer_instructions`. Real provider and profile settings after the closing delimiter are still
checked, even when an escaped quote immediately precedes that delimiter.

The **OAuth reliability** section reports whether credential storage is writable, whether refresh
single-flight/lock files can be created under `OPENCODEX_HOME`, non-healthy OAuth or Codex pool
accounts (redacted ids) with a recovery `Action:`, and a static OK that the Codex forward path does
not fabricate official-client metadata. Doctor never mutates credentials or applies repairs.

## Catalog sync

### `ocx sync [--restart-codex] [--restart-app-server-only]`

Fetch the live model list from every configured provider and re-inject the merged catalog into Codex.
Run it after adding a provider or to refresh available models.

Before provider discovery or catalog/cache replacement, `ocx sync` validates that the managed
Codex configuration can be injected. If that validation refuses the config, the command exits
nonzero, prints the concrete reason on stderr, and leaves the existing catalog and cache unchanged.
`ocx restore back` uses the same no-write preflight before it re-enables routing.

If long-lived Codex `app-server` processes are still running, `ocx sync` warns that they may keep
serving the previous in-memory model list even though `opencodex-catalog.json` / `models_cache.json`
were updated. Pass `--restart-codex` to restart matching `codex … app-server` and
`codex-code-mode-host` processes **and** fully quit and relaunch the Codex desktop app, on macOS,
Linux, and Windows, so the model picker re-reads the catalog. Live conversations end. Broad
`pkill -f codex` matching is intentionally avoided.

`--restart-desktop-app` is a deprecated alias of `--restart-codex`. It still works, prints a
deprecation notice, and is not Windows-only.

`--restart-app-server-only` restores the older, narrower behaviour: `SIGTERM` only to matching
app-server and code-mode-host processes owned by the current user, with the desktop app left
running. Active turns may still be interrupted. If it is combined with `--restart-codex` or
`--restart-desktop-app`, the narrow scope wins, because losing live conversations is unrecoverable
and a stale picker is not.

When the command runs from inside the Codex app, the restart is handed off to a detached helper
and this session ends with the app.

### `ocx sync-cache [--restart-codex] [--restart-app-server-only]`

Invalidate Codex's local model picker cache so it is rebuilt from the active opencodex catalog. The
same stale-`app-server` warning and optional restart flags as `ocx sync` apply.

If the derived cache already has identical bytes, the command succeeds without rewriting it or restarting Codex. With `--json`, this is reported as `ok: true`, `wrote: false`, `skipped: true`, and `skippedReason: "unchanged"`; an invalid catalog or failed cache write still exits nonzero.

### `ocx catalog pull <https-url> [--auth-env <NAME>] [--json] [--restart-codex] [--restart-app-server-only]`

Install a complete catalog served by another OpenCodex instance's `/v1/catalog` endpoint, then
synchronize `models_cache.json`. Unlike `ocx sync`, this command does not discover configured
providers or inject Codex configuration. Unlike `ocx sync-cache`, it replaces the active catalog
before rebuilding the cache. It works even when the local Codex integration desired state is off.

The URL must be HTTPS; loopback HTTP is accepted for local testing. Embedded URL credentials,
queries, fragments, redirects, oversized responses, malformed JSON, duplicate or unsafe slugs, and
unknown `input_modalities` are refused before any local write.

Loopback HTTP requests are refused before authentication headers are attached or any request is sent when `HTTP_PROXY` or `http_proxy` applies without a matching `NO_PROXY` or `no_proxy` bypass. `ALL_PROXY`/`all_proxy` and settings limited to `HTTPS_PROXY`/`https_proxy` do not trigger this HTTP restriction; HTTPS catalog acquisition remains allowed. The refusal message includes neither the proxy address nor the authentication token. Nonempty `http_proxy` and `no_proxy` take precedence over `HTTP_PROXY` and `NO_PROXY`, respectively. For Bun-compatible bypass rules, use hostnames, matching `host:port` entries, bracketed IPv6 addresses such as `[::1]`, or `*`; do not use URLs, paths, or `*.` prefixes.

Authentication is optional and is
read only by environment-variable reference:

```bash
export OPENCODEX_CATALOG_AUTH_TOKEN='...'
ocx catalog pull https://proxy.example.com/v1/catalog \
  --auth-env OPENCODEX_CATALOG_AUTH_TOKEN
```

The value is sent as a Bearer token but is never accepted as an argv value. Redirects are refused,
so authorization cannot cross origins. Catalog and cache writes use the shared Codex catalog lock
and atomic writer. A failed fetch, validation, lock acquisition, catalog write, or cache rebuild
preserves the last-known-good files. Identical catalog bytes are a no-op that preserves mtimes and
never touches processes. `--restart-codex`, `--restart-app-server-only`, and the deprecated
`--restart-desktop-app` alias mean the same thing here as they do on `ocx sync` and
`ocx sync-cache`, and they apply only after a real write.

The URL must name `/v1/catalog` at the host root. A reverse proxy that serves the endpoint under a
path prefix is not supported by this command.

The command downloads the full catalog and compares bytes locally instead of issuing an `ETag` /
`If-None-Match` conditional request. Identical bytes are treated as a complete no-op, so a
Codex home whose catalog is correct but whose `models_cache.json` is missing or stale is not
repaired by this command; use `ocx sync-cache` for that.

`--json` emits one stable envelope on stdout. `schemaVersion`, `ok`, `status`, `catalogWritten`,
`cacheSynced`, and `codexRestarted` are always present. `codexRestarted` still means app-servers
only. `desktopAppRestarted` is present only when a desktop restart was requested, and is `true`
only when the relaunch actually started; a handoff is not a success. `status` is `updated`,
`unchanged`, or `failed`. A successful pull adds `modelCount`; a failure adds `code`, which is the
field a script branches on:

| `code` | Meaning | Exit |
| --- | --- | --- |
| `usage` | The arguments were not a valid `catalog pull` invocation | 2 |
| `auth_env_missing` | `--auth-env` named a variable that is not set | 1 |
| `url_invalid`, `insecure_http_refused` | The URL was refused before any request | 1 |
| `request_failed`, `redirect_refused`, `http_error` | The request did not produce a usable response | 1 |
| `body_too_large`, `body_invalid`, `catalog_invalid` | The response was refused before any local write | 1 |
| `write_failed`, `lock_database`, `unsafe_path` | The coordinated write did not complete; files are unchanged | 1 |
| `lock_busy` | Another writer holds the Codex catalog lock | 3 |
| `restart_incomplete` | The catalog and cache landed, but a Codex app-server survived `--restart-codex` or `--restart-app-server-only` | 1 |

`restart_incomplete` is the one failure that reports real writes: `catalogWritten` and
`cacheSynced` stay true and `ok` is false, because a surviving app-server still serves the
previous catalog from memory.

## Background service

### `ocx service [install|repair|restart|start|stop|status|uninstall|remove]`

On Windows Task Scheduler, the service wrapper restarts the proxy after five seconds
even when an external tool terminates it with exit code 0. If another opencodex proxy
already owns the port, the wrapper exits deliberately. Use `ocx stop` or
`ocx service stop` to stop the service and its restart loop. After upgrading an
existing installation, run `ocx service repair` to refresh the generated wrapper.

Run opencodex as a login-managed background service (macOS **launchd**, Linux **systemd user unit**,
Windows **Task Scheduler**) that auto-starts on login and auto-restarts on crash. Service runs set
`OCX_SERVICE=1` so a restart does not churn the Codex config.

Windows Task Scheduler installs use normal process priority (`Priority=4`). The older background
priority (`7`, also the scheduler default when omitted) can delay the proxy's health responses under
CPU contention, making the tray report Offline even while the process is alive. After upgrading,
run `ocx service repair` to migrate that registered priority and restart the service. This migration
may request UAC approval; a priority already set to normal or high does not itself trigger replacement.

The Windows wrapper verifies its baked Bun runtime and CLI entry before every start attempt. If an
interrupted package update removed either file, it logs one `installation is incomplete` message and
stops instead of retrying the same missing executable every five seconds. Reinstall opencodex, then
run `ocx service repair` to refresh the task with the restored package paths.

On Linux, the systemd unit invokes the first regular, executable `ocx` file found on `PATH` at
install time rather than the Bun and CLI paths inside the installed package tree. Version managers
such as **mise** and **asdf** install into a versioned directory and delete the old one on upgrade;
their stable shim keeps the unit resolving. Source checkouts without an `ocx` launcher keep the
direct Bun + CLI form. A trusted `OPENCODEX_BUN_PATH` selected before Bun starts is preserved
through the shim; package-local bundled Bun paths are rediscovered after upgrades.

On macOS, launchd instead uses the package-local Bun and CLI paths selected during install or
repair. This prevents a mutable PATH shim from receiving the service API token and configured proxy
environment on a later restart. After upgrading a version-manager installation, run
`ocx service repair` to refresh those paths before restarting the service.

Definitions installed before this change still carry the old versioned paths and cannot migrate
themselves — once the old executable is deleted, no opencodex code runs to fix it. Run
`ocx service repair` once after upgrading. Linux service starts then follow the launcher; macOS
repair writes the new package paths into the launchd definition.
An already-running proxy is not replaced by an external upgrade: when the installed CLI is newer
than the running proxy, run `ocx service restart` so the new build serves. On macOS, `repair` is not
enough there: the definition did not change, and a repair that changes nothing reloads nothing.
If the proxy is newer instead, check the CLI installation and `PATH` as described under
[`ocx status`](#ocx-status---json).

| Subcommand | Action |
| --- | --- |
| none | Install and start when absent; otherwise `repair` the existing service. A healthy Windows scheduler definition is reused; a stale definition may be re-registered and require elevation. |
| `install` | Create and start the service. Registers it, which on Windows needs elevation. |
| `repair` | Refresh an installed service in place. On macOS, the manager is reloaded only when something changed, so a healthy, unchanged job keeps running and the repair is not an outage. On Linux and Windows, the service is restarted; a healthy Windows scheduler definition is reused, while a stale definition may be re-registered and require elevation. |
| `restart` | The same refresh and a guaranteed restart on every platform. On macOS an unchanged, already-loaded job is kickstarted in place. Not an alias of `repair`. |
| `start` | Start an installed service. |
| `stop` | Stop the service and restore native Codex. |
| `status` | Report service and proxy diagnostics plus log paths. |
| `uninstall` | Remove the service and restore native Codex. |
| `remove` | Alias of `uninstall`. |

On Windows, a bare `ocx service` runs the install path only after both Task Scheduler and WinSW are
proven absent. If either status query is inconclusive, it refuses to register anything and asks you
to run `ocx service status`; use explicit `ocx service install` only after confirming absence.

### Runtime ownership

The OpenCodex desktop app can take the background proxy over from a CLI installation. When it does,
it records the handover in the shared service install state, and that record is what makes the
takeover survive a restart. Your service registration is **kept, never deleted** — the record
supersedes it rather than replacing it.

A state file with no ownership record means the CLI installation owns the runtime, which is what
every installation made before this feature is in. Nothing changes for you until an app takes over.

While something other than this CLI owns the runtime, the subcommands that would **activate** your
registration refuse instead:

| Subcommand | Behaviour under a foreign owner |
| --- | --- |
| `repair`, `restart` | Refuse before changing anything. The registration is not re-enabled, rewritten or restarted. |
| `start` | Refuses for the same reason, so an automatic tray start cannot put a second proxy beside the app's. |
| `stop`, `uninstall` | Unchanged. They deactivate, so they are never gated. |
| `install` | Takes the runtime back. It clears the ownership record after the registration succeeds, and reports whose it was. |

`ocx update` behaves the same way: it neither stops the running proxy nor refreshes the service
while the app owns the runtime, because the running server is the app's own bundled binary and the
refresh would re-enable the launcher the takeover superseded. The app updates its own runtime.

The refusal names the owning installation and the consent generation, for example:

```text
Background service repair stopped: the desktop app owns the runtime (install <id>, consent generation 2).
The service registration was left exactly as it is — not re-enabled, not rewritten and not restarted.
Quit the desktop app and run 'ocx service install' to hand the runtime back to this CLI.
```

A record that cannot be read or does not parse produces the same refusal with a different first
line, because an unreadable claim is not the same as no claim — treating it as "nobody owns this"
is how a permissions error would silently reactivate your service.

**Recovery in every case is `ocx service install`.** It is deliberately the one verb that is never
gated, so removing the app without handing the runtime back, or a corrupted state file, still leaves
you a way to take the service back:

```bash
ocx service install
```

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
If installation is refused or the resulting shim is unhealthy, the command exits nonzero and
the dashboard reports the failure reason. A healthy existing shim still counts as success.
For Windows installations that expose only `codex.exe`, use `ocx service install` for autostart.

Before an install or repair is committed, OpenCodex runs the saved launcher with `--version` while
service startup is bypassed. It refuses the change and rolls back when the launcher resolves
`codex` back to the shim, exits nonzero, exceeds five seconds, leaves descendants running, or
cannot be validated and cleaned up safely. Therefore `codex-shim install` is not unconditional. If
it is refused, reinstall Codex so the PATH entry is a concrete executable or launcher and retry;
use `ocx service install` instead when a dynamic command-manager launcher cannot meet these checks.
Cleanup refusals include a bounded diagnostic suffix identifying the probe phase, a recognized
native error code or signal, and the exit status when known. It does not include launcher paths
or raw child output, and does not relax the validation or rollback checks.
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

:::note[Windows token environment]
Newly generated Windows CMD and PowerShell shims restore the caller's `OPENCODEX_API_AUTH_TOKEN` after execution. Codex and its child processes can still inherit the token.

After updating OpenCodex, recreate an existing Windows shim with `ocx codex-shim uninstall` followed by `ocx codex-shim install` to obtain this behavior. An ordinary update does not rewrite a healthy Windows shim.
:::

:::tip[Service vs Shim]
Use `ocx service` for an always-on background proxy (recommended). Use `ocx codex-shim` for
lightweight, on-demand startup without a daemon — the proxy starts only when `codex` is launched.
:::

#### Token injection into Codex

On a non-loopback bind the injected provider carries `env_key = "OPENCODEX_API_AUTH_TOKEN"`. That
line tells Codex which variable to read; it does not create it. Codex refuses to start a request
when the variable is missing (`Missing environment variable: OPENCODEX_API_AUTH_TOKEN`), and the
proxy is never reached. The value lives in `$OPENCODEX_HOME/service-api-token`; the launching process
must supply it in Codex's environment.

Use the maintained shim installed by `ocx codex-shim install`. When the launching context resolves
this shim, it reads the token file created by OpenCodex and supplies the variable to Codex.
Desktop, cron, and service launches must use a PATH or launcher path that selects the shim;
installation does not configure those environments automatically. Codex's own child processes
may still inherit the token.

Do not export this bearer token from a shell startup file or copy it into `config.toml`. The
`service-api-token` file contains the raw token, not `NAME=value` assignments, so it cannot be used
directly as a systemd `EnvironmentFile=`.

An `EnvironmentFile=` or `OCX_API_TOKEN_FILE` on `opencodex-proxy.service` configures the proxy process
only and never flows into an independently launched `codex exec`.

A Codex upgrade that replaces the launcher removes the shim; the next ordinary `ocx` command restores
it (see above), but a `codex exec` that runs before that fails. `ocx doctor` reports this exact
state under "Codex env_key launch readiness" (env_key configured, variable unset, shim missing or
unhealthy, token file present) with the repair command, and never prints the token. Reading the token
file is not part of the injected `env_key` contract; the launching process must supply that variable.

### `ocx tray <install|start|stop|status|uninstall|remove> [--json] [--no-start]`

Install and control the Windows status tray icon. It starts at Windows login and provides one-click
proxy controls. `start` and `stop` control the icon only; use its menu to control the proxy.
`--no-start` applies to `install` and installs the tray without launching it immediately.
Deprecated: the OpenCodex desktop app provides the tray on Windows, macOS, and Linux; `ocx tray`
remains for installs without the desktop app.
When a newer package version is known, the tray adds a blue dot to its online, warning, or offline icon and shows **Update available**. The tray checks its local cached badge about once a minute; stale or unavailable results remove the dot. The menu item opens the dashboard, where you can start the package update. It does not install automatically.

## Dashboard

### `ocx gui`

Open the [web dashboard](/guides/web-dashboard/) at `http://localhost:<port>` — or at
`http://127.0.0.1:<management port>` when hub management ingress is enabled — auto-starting the proxy
if it is not running.

## Updating

`ocx update` updates OpenCodex itself; it does not update the Codex CLI. Use the
[system inspection commands](/reference/cli/agents/) to inspect the configured Codex CLI candidate
with bounded, read-only provenance inspection. `ocx system codex-cli-update check` does not query a
package registry or install an update.

### `ocx update [--tag latest|preview]`

When OpenCodex is installed through mise, this command exits unsuccessfully before stopping the proxy or changing package files and shows `mise upgrade <tool>`, using the verified local mise alias. Update checks remain available and report the installation as externally managed. An unreadable or inconsistent mise ownership record fails closed without guessing a tool name, and `--tag preview` never changes mise's configured selection.

On Linux, a background service whose recorded launcher is mise's package launcher (`<tool>/latest/node_modules/.bin/ocx`, not a mise shim) follows `mise upgrade` by itself: within about ten seconds of the new version settling, it drains active requests and restarts onto it, and it recovers the same way if mise later prunes the version it was running. On macOS, for a service installed through a mise shim, and for a foreground proxy, restart it yourself after upgrading (on macOS, `ocx service repair` first).

Self-update opencodex from npm. Stable installs use `@latest`; preview installs stay on `@preview`
unless you pass `--tag latest|preview`. It detects a source checkout and tells you to
`git pull && bun install` instead, and is a no-op if you are already on the newest version for that
tag. Before stopping anything, npm installations run a bounded Unix cache ownership and access
check. Nested symlinks are checked with `lstat` but not followed; Windows explicitly skips this
Unix-only check. A failure aborts while the tray and proxy are still running. A running proxy is
then stopped before files are replaced; an installed service is rebuilt and started automatically,
while a foreground installation prints `ocx start` as the next step. Dashboard update records
redact profile/cache paths and UID/GID values before they are persisted.
If the install step fails, the previous version stays installed and its service is restarted; the
terminal output names the next step, and [Update Failed on Windows](/troubleshooting/update-failed/)
covers finishing the update and the folders a failed attempt can leave behind.

```bash
ocx update
ocx update --tag preview
```

New versions become available when the [Release workflow](https://github.com/lidge-jun/opencodex/actions/workflows/release.yml)
publishes them to npm.

## Remote Hub client lifecycle

Use `ocx connect <url> --pairing-code-stdin`, `ocx connect status`, `ocx sync`, and `ocx connect rotate --pairing-code-stdin`. The initial catalog download fails after five seconds without incoming bytes, but active transfers may run longer; use `--catalog-timeout <seconds>` (1–120) to override that inactivity window. `ocx disconnect` restores local state offline and does not revoke the hub key. While connected only, `ocx connect revoke --admin-token-stdin` revokes the persisted `apiKeyId`; after disconnect use the hub's **Integrations → API Keys** page. Secrets are stdin-only and never belong in argv.
