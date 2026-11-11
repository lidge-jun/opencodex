---
title: CLI Lifecycle
description: Setup, start, stop, service, diagnostics, sync, and update commands.
---

These commands install, run, inspect, repair, and update the local opencodex proxy and its Codex integration.

## Discover before starting services

`ocx help`, `ocx help <family>` and `ocx help <family> <leaf>` are offline.
Use `ocx help --all` when the compact root is insufficient. Help, local config
validation and local Lab inspection do not require starting a proxy.

Before a live management workflow, run `ocx ready --json` and `ocx status --json`.
Readiness distinguishes `pending`, `failed` and `unreachable`; only `ready: true`
confirms readiness. Check the target and `versionSkew.relation`: `unknown` is not
proof of matching versions. A version mismatch calls for resolving the intended
installation, not repeatedly trying a newer flag against an older server.

Output and exit conventions are command-specific. `ready` and `resolve` reject
invalid arguments with 64, while `doctor --json` is unsupported and exits 2.
A successful local save or accepted restart request does not prove convergence;
read the command receipt and re-check status after the requested operation.

When live target discovery finds no proxy, policy/catalog commands, key-scoped usage and
Aside profile sync report: “Proxy is not running. Start the intended proxy with: ocx start.
No request was sent.” A management request that was sent can still have an uncertain write
outcome; read back from the intended target before retrying. Legacy client-integration
refusals add fixed recovery guidance keyed on the refusal reason (never the writer's own text);
backup and residual-recovery notices remain available.

`ocx system update run --yes` prints the accepted job ID and observed job state. Follow it
with `ocx system update status <job-id>`; acceptance does not establish successful installation
or restart. `--json` retains the complete server response.

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
Grok and Claude stay pointed at the proxy that was already running. With a separate
`OPENCODEX_HOME`, startup checks the default home's runtime record and managed Grok and
Codex loopback destinations for a live opencodex owner before syncing. A custom home with
no live owner still syncs normally; explicit `ocx sync` and `ocx grok apply` remain available.
Stopping that sibling with `ocx stop` or a signal leaves their configuration alone as well. While it runs, the proxy also
keeps Codex pointed at itself: when the opencodex routing in `~/.codex/config.toml` names another
local port where no opencodex has answered for about 20 seconds (an instance that re-pointed it and
then died, for example), the proxy re-points Codex at its own port and prints one warning. Codex
threads opened in the meantime keep the dead address until you reopen them.

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

An unsupervised Link Child handling a shutdown signal restores native Codex and managed Grok before releasing its listener, rechecking the served connection before each write. Service/Desktop supervision, sibling ownership, restart/recycle handoff and pending parent stop receipts preserve integrations. Shutdown rejects bound restart with `409 runtime_stopping`. Forced termination can bypass signal handlers; parent `ocx stop` restoration remains necessary. To route Codex through Home again after such a stop, start the Child (`ocx start`, or `ocx service start` for an installed service) and then run `ocx sync --restart-codex`. Starting alone does not reapply routing. A sync run while the Child is stopped still reapplies routing, which points Codex at a listener that is not running, so start the Child first.

Stop the running proxy (by PID), remove the PID file, and restore native Codex for standalone owners. If a managed
background service is installed, `ocx stop` also stops it first so it cannot respawn the proxy.
On a connected hub client, `ocx stop` leaves Codex routing, its
model catalog and the Grok config as they are, including after a successful API stop: the connection
owns them, and `ocx start` serves them again without re-injecting routing. Use `ocx disconnect` to hand Codex back to its own account. If Codex on a connected
client already reads native routing, `ocx status` names `ocx sync --restart-codex` to point it back.
An explicit stop on a Remote Link Child restores native Codex routing, catalog and backed-up
resume-history metadata and removes the managed Grok configuration when shared restoration succeeds.
The saved Home connection is kept; `ocx disconnect` removes it. To use Home from Codex again,
start the Child with `ocx start` (or `ocx service start` for an installed service), then run
`ocx sync --restart-codex`. Starting alone does not reapply routing; sync does not recreate the Grok block.
If connection ownership cannot be confirmed before service stop, the stop API returns HTTP 409 with
`sharedTeardown: "refused"` and keeps the proxy and service manager running. Let any pending
connect or disconnect finish, then retry.
A connected stop verifies the listener against the protected local runtime record before changing
its service. Both client-role listeners and ordinary proxies must prove that identity; an ordinary
proxy must also advertise preservation across API, signal and service shutdown in an authenticated
read. Older or unverified runtimes are refused before
stop actions. Update/restart that runtime through its supervisor and retry; use `ocx disconnect`
only when you intend to release the connection-owned integrations.
Repeated stops of an already-stopped client confirm service-manager inactivity and absence at the
known local endpoints before returning the normal not-running result.
While the OpenCodex desktop app is running, `ocx stop` does not keep the proxy down: the app treats
it as an unexpected exit and starts a proxy again, within seconds for one it started and after about
a minute for one it had only attached to. Use the app's tray **Stop proxy** (for a proxy the app
started) or **Quit** to keep it stopped. For the same reason the dashboard's stop (the sidebar proxy lever pulled all the way down) refuses
with `desktop_supervised`, and changes nothing, for a proxy the app started.
The web dashboard's stop lever runs the same action (`POST /api/stop`) on every backend
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
79 when only Codex history cleanup did not complete, 80 when the shared teardown was deferred
and is still owed, and 81 when a dashboard update that will restart the proxy handed Codex routing
and its catalog to the restarted proxy instead of restoring native Codex. With 81 the proxy is
down, and the restarted proxy releases the kept teardown after its first sync; if it never starts,
the next `ocx stop` restores native Codex.

For a desktop-approved takeover, `ocx stop --json` also accepts the complete set of
`--expect-*` values supplied by `ocx resolve --json`. On Windows, this guarded stop can
stop a Task Scheduler task only when its registered definition, running state, and wrapper
ancestor prove it owns the approved proxy. A WinSW service must prove its installed binary
path and service PID ancestry. After stopping either manager, the CLI signals the approved
proxy separately and verifies that the task is no longer running, no wrapper survives, and
WinSW is stopped. A `wscript.exe`, `cscript.exe`, or `cmd.exe` process with an
unreadable command line in the approved proxy's supervision chain (or surviving under the
stopped manager) leaves wrapper ownership unknown, so the guarded stop cannot report success.
Missing or unreadable evidence blocks the guarded stop.

New runtime records include the bound hostname. For older records that omit it, a guarded
stop accepts the discovered default loopback address only when the remaining approval and
ownership checks agree. An omitted hostname cannot independently prove the listener's bind
scope. When the record contains a hostname, it must match the approved value exactly;
wildcard and loopback binds remain distinct.

### `ocx restart`

When this CLI is newer than an attested standalone POSIX proxy, restart can stop the old
installation and launch this one. This guarded update requires an unclaimed physical home,
a detached proxy whose parent is PID 1, positively inactive service supervision, and a known CLI
version. An installed but unloaded launchd or inactive systemd service record is eligible only
when it carries no ownership claim. Both launchd domains must be absent; systemd must report
inactive with MainPID zero. Unreadable or uncertain manager evidence refuses. The command freezes
all service records and the platform definition and checks them through stop, launch and child
publication. Any rewrite, replacement, permission change or record creation/deletion refuses;
retry after inspecting `ocx status`.
The stop uses the same connection that proved the old proxy's identity. The command launches
once only after confirmed shutdown, then requires the exact child PID, endpoint, fresh identity
proof and matching version. Missing version, uncertain stop, timeout or an unexpected replacement
reports failure without another stop or start. If the runtime this CLI would launch is still the
small placeholder an in-place npm install leaves before its postinstall, restart refuses before
stopping anything; after a confirmed stop it waits for the runtime within the same deadline and
launches nothing if it does not arrive. Windows, foreground, desktop-supervised, active-service,
connected-client and sibling runtimes do not use this update path; use their owning lifecycle
controls. A newer proxy or incomparable version still refuses an in-place downgrade. Use the newer
installation's `ocx` to restart; inspect `which -a ocx` and `ocx status` to identify it.
Eligibility refusals name the reason and next action: use the owning installation's
`ocx service restart` for a service, the owning terminal for a foreground proxy, or the
owning service/desktop app on Windows. Unknown ancestry or a changed target calls for
`ocx status` before any restart.

On a connected client runtime (a Remote Link Child or a hub client), `ocx restart` asks the runtime
to start its own replacement on the same port. If the replacement does not answer within the
restart budget it is stopped, and the old runtime binds the port again and keeps serving; the
command then reports the restart as not completed. A client runtime run by a background service or
the desktop app refuses the request and keeps serving ("Restart not performed; the running client
runtime was kept"); restart it with `ocx service restart` or from the app. See
[Remote Link apply parity](#remote-link-apply-parity).

If package files or the Bun runtime remain incomplete after the installer exited or failed,
run `ocx status`, stop any running proxy through its owner (`ocx stop`, or its service or
desktop app), then reinstall with the same package manager and start it again. See
[Update failed](/troubleshooting/update-failed).

When a proxy is running, ask that exact attested PID and port to restart in place, wait for its
normal drain, and verify a different runtime PID on the same port. Managed routing and service
supervision stay installed throughout; an uncertain request is observed rather than replayed as a
separate stop/start. If no proxy is running, the command falls back to the normal `ensure` start.
If an accepted restart loses its replacement, the command attempts a bounded recovery start even
when Codex autostart is disabled, and reports failure if no proxy starts.
When the proxy starts its own replacement (no background service supervises it) after the drain
finished normally, a replacement that exits before it answers is started again up to twice. What
the replacement prints goes to `~/.opencodex/restart-handoff.log`, which stays near 256 KiB: a
restart empties it once it reaches that size, and the running replacement checks it once a minute.
A proxy the OpenCodex desktop app started does not start its own replacement: it exits, and the app
starts the new proxy on the same port.
If a live listener cannot be attested to a runtime PID (including a pre-update proxy), restart fails
closed without an `ensure` or stop/start fallback. After confirming ownership, use `ocx stop` then
`ocx start` for a standalone proxy. For a service-managed proxy, use `ocx stop` followed by
`ocx service start` so supervision is restored.
One invocation re-observes transient discovery races. A failed start is retried only when
the previous attempt never launched a child or the launched child is known to have exited.
If a launch may still be running, restart reports the original failure without starting
a second proxy, even when a health probe finds nothing. When an accepted restart never publishes a replacement, the command re-observes
once before giving up — a proxy that crashed mid-restart reads absent and is started fresh,
while a replacement that landed just past the shortened replacement wait still proves success within the overall observation deadline. Outside the guarded newer-CLI update path, a live target is
never stopped to make room, so a stale-but-listening process can not be replaced by a second
proxy racing it for the port.
Every failed start attempt is followed by a beat and a strong re-observation before the
next attempt: a child that was just launched may still be binding, and post-health steps
may have thrown on an already-serving proxy. A live reading means
no second start is spawned: a clean refusal then attests success, while a throw
propagates as a start failure because post-health work failed on a serving process.
During crash recovery after an accepted live restart, success instead requires a different
runtime PID on the original port: if the original PID reads live again, the restart fails
as a missed replacement rather than reporting success.
Confirmed absence and launch-exit evidence together permit another start attempt. While the previous PID is still live, or a probe is uncertain, the
confirmation window keeps polling for a replacement inside the reserve instead of
failing at once. A second proxy is never spawned next to a live one.
The replacement wait ends early enough that the confirmation window still fits inside the
overall observation deadline.

Port recovery after stop or update respects a failed OCX process check even when the PID was
recorded before shutdown. A rejected live holder is left running and prevents TCP-row cleanup.
If it stays unverified, the bounded recovery wait can expire with the port still busy. Check the
current port holder and retry the restart after the conflict is resolved.

### `ocx ensure`

Idempotently ensure a background proxy is running, then sync its live model catalog. If
`codexAutoStart` is `false`, it prints that autostart is disabled and does nothing.

With a validated connected-client configuration, `ensure` succeeds without starting a local
provider proxy after reconciling the client journal. This does not probe or certify the remote
hub's availability. Invalid or mismatched client state still fails.

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
then converts only OpenCodeX-owned `ocx1:`/`ocx2:` compaction state into a plain summary that native Codex
can replay. Native encrypted content and other threads are left unchanged. Close the selected
thread before running the command; a concurrent rollout change makes recovery stop without
replacing the file.

### `ocx uninstall` · `ocx remove`

Stop the service and proxy, remove the service and Codex shim, restore native Codex, then remove
opencodex local config only if all restore steps succeeded. `remove` is an alias of `uninstall`.
Config cleanup requires ownership metadata created by a fresh install; legacy or shared directories
are left in place.

When `ocx uninstall` runs as root or from an elevated (administrator) Windows prompt, it first
checks that no other account can change the config directory, the directories above it, or any
directory inside it, and that no link inside the config directory leads outside it (on Windows, that it holds no links at all). If either check
fails, uninstall stops before it changes anything and says why. Run `ocx uninstall` as the account
that owns the config directory, without `sudo` or administrator rights, or restrict those directories
to that account and remove such links, then run it again. On Windows ARM64, where opencodex cannot
tell whether the prompt is elevated, the same check applies; if it cannot be completed, stop opencodex
and remove the config directory yourself.

A recorded entry whose parent directory inside the config directory is a link (a symlink or junction)
is left in place and listed as a remaining path, and the run ends as a partial uninstall. Replace that
link with the real directory or remove it, then run `ocx uninstall` again to finish.

Both commands accept no arguments. Unsupported flags (including `--dry-run` and `--yes`)
exit with usage status 2 before preflight or teardown; no changes are made.
For help, run `ocx help uninstall` or `ocx help remove`.

## Status and health

### `ocx status [--json]`

Status and `ocx doctor` compare this CLI's version with the running proxy. If the CLI is newer,
restart the proxy using the intended current installation; for a background service, run
`ocx service restart`. On macOS, a version skew leaves the service definition byte-identical, so
`ocx service repair` would reload nothing and keep the old process serving. If the proxy is newer, upgrade the CLI
or resolve `PATH` to the intended installation. These diagnostics do not repair the service or
change whether requests are allowed.

If an update restart reports a blank hostname in the runtime record, it leaves the proxy running.
Use `ocx status` and `ocx service status` as clues, not proof of ownership or the actual bind.
Once ownership is verified, for a service use the owning installation's `ocx service restart`;
for Desktop, use the app; for a foreground proxy, use its terminal. A standalone proxy started by `ocx ensure` may be
detached and have no terminal:

1. Independently verify the process identity, installation, home, supervisor and actual listening
   address and port. Use OS process and listener inspection with sufficient permissions; check
   IPv4, IPv6 and wildcard listeners as applicable. A PID alone can be reused, and missing or
   incomplete inspection results do not prove ownership or absence. For example, on macOS or
   Linux where `lsof` is available, `ps -p <pid> -o pid=,ppid=,args=` and
   `lsof -nP -iTCP:<port> -sTCP:LISTEN` provide process and listener clues. They do not by
   themselves establish the home, supervisor, or complete visibility; use the appropriate OS
   tools and permissions to verify those separately.
2. Only if those facts are verified and forced termination is acceptable, the owner can run
   `ocx stop` from the owning installation and home. It tries a graceful stop first, but may
   fall back to forced termination if that fails; it can also refuse, including when the blank
   hostname prevents guarded ownership verification. Do not bypass a refusal.
3. Independently confirm the identified process has exited, no supervisor will restart it,
   and the intended address and port are free. A successful stop or a status result alone is
   not proof of all three. Once confirmed, run `ocx start` from the intended installation and
   home with the intended bind and port settings; a successful start regenerates the record.

If any check is incomplete, the stop fails or is refused, or forced termination is unacceptable,
stop and ask the owner or administrator to investigate. Do not edit the runtime record or kill
unrelated processes. Retry the update restart if needed after the new proxy is running.

Identical version strings and the `unknown` / `0.0.0` placeholders suppress the warning, as does
an absent proxy version. Doctor does not report placeholders as a confirmed match. Different
strings still produce a neutral warning when they cannot be strictly parsed as SemVer or differ
only in build metadata; neither side is called older. Versions are not trimmed and a leading `v`
is not normalized. JSON exposes the same advice in `versionSkew`, whose fields remain
`cliVersion`, `proxyVersion`, `skewed`, and `warning`.

On a Remote Link Child and its Home, `--json` also reports `appliedCodexSettingsDigest`,
`lastApplyAt` and `runtimeStartedAt`; see [Remote Link apply parity](#remote-link-apply-parity).

Print a read-only diagnostic summary: proxy PID, `/healthz` reachability, dashboard URL, config path,
default provider, Codex autostart setting, service state, shim state, and the redacted effective Codex
home. Only the explicit, high-confidence Windows Orca runtime-home signature adds an actionable App-home
mismatch warning; it never changes `CODEX_HOME` automatically. It also warns when the Codex routing
opencodex wrote names a local port the running proxy does not serve. `ocx sync` repairs it
immediately, and a running owner proxy may also re-point it on its own once nothing answers on that
port. A sibling's status does not report it, because its routing names the proxy it runs beside.

When a live proxy has already passed the identity/liveness check, `ocx status` prefers that process's
attested startup-health report for restart safety and service viability. This avoids false negatives
from a shell-local service-manager probe that lacks the running service's manager environment. The
live report is schema-validated; if it is unavailable or malformed, status falls back to the local
service and shim diagnostics. `ocx doctor` uses the same live-first rule for its **Codex restart safety**
section, so the two commands should agree on restart protection. If you are diagnosing a discrepancy,
compare the reported live startup verdict with the local service details rather than treating the shell
probe as more authoritative.

The live read allows the bounded service probe to finish: up to 6.5 seconds on macOS/Linux
and 16.5 seconds on Windows when the diagnostic cache is cold or expired. Cached reads return
promptly. A timeout still falls back to local diagnostics; a healthy `/healthz` alone does not
establish restart protection.

The `clients=pending-restart(...)` diagnostic lists Codex CLI clients that predate the routing
injection. On macOS, Electron renderer, utility, and crashpad helpers under Codex.app's framework
are excluded from that client list, including helpers whose executable paths contain spaces.

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

### `ocx system health [--json]`

```bash
ocx health --json
ocx system health --json
```

Root health is the liveness probe. System health is a separate management
observation: `{status:"ok",service:"opencodex",version,uptime,pid,spendLedger}`,
with uptime in seconds. `system status` remains its settings/startup/memory aggregate.
A valid system-health observation exits 0 even if the spend ledger is degraded.
Read ownership held/unheld, initialized, configured, degraded, persistFailures and
corruptRecords; status ok does not certify every subsystem healthy. Failed/malformed
reads remain nonzero with safe stderr, not fabricated healthy data.

For bounded diagnostics, [request/injection follow](/reference/cli/agents/#follow-request-windows-or-injection-sequences)
stops on error or detected target change instead of reconnecting automatically.
SIGINT exits 130 and SIGTERM 143. Versioned log events reconstruct observed windows,
not traffic missed between polls; injection seq cannot exclude restart/eviction gaps.

### `ocx ready [--json] [--wait [--timeout <seconds>]]`

Check post-sync readiness through the unauthenticated `GET /readyz` endpoint. It returns `200` when
ready, or `503` with `Retry-After: 1` for `pending` and terminal `failed`. Its sanitized HTTP identity
is `{service, version, uptime, pid, port, status}` plus the remote-hub protocol fields
`{protocol, minimumClientProtocol, managementUrl, features}`. `protocol` is the hub protocol this proxy
speaks and `minimumClientProtocol` the oldest client it still accepts, so a client can refuse an
incompatible pairing before sending anything else. `managementUrl` is the origin a client should
use for the management plane: the configured `hub.managementPublicOrigin` when `runtimeRole` is
`hub`, and otherwise the origin the request itself arrived on. A readiness request with no
HTTP(S) origin is rejected rather than answered with a guess.
`features` lists the peer features this build serves, so a peer can check a capability without
comparing versions: `relay-auth/<n>` names the Remote Link relay authentication version,
`link-management-relay` the read-only Remote Link management relay, `link-peer-report/<n>` that
a Remote Link Home reports each Child's version and compatibility in `ocx link status`, `quota-pool/1` the
`GET /api/quota-pool` management read, and `served-by-header` the `x-opencodex-served-by` response
header. A feature this build does not serve is absent. The list holds fixed names only, never
account or configuration data. Old proxies without `/readyz` fail
closed as `unreachable`; `/healthz` is separate liveness, not readiness. The command performs one probe by
default; `--wait` polls until ready or timeout, but exits immediately when it observes the terminal `failed` state. The
default timeout is 45 seconds; `--timeout <seconds>` requires `--wait` and accepts positive integer seconds from 1–300.
The CLI's own `--json` output is deliberately narrower than the HTTP body: it emits
`{ready, status, pid, port}`, where `status` is `ready`, `pending`, `failed`, or
`unreachable`. Exit codes are 0 for ready; 1 for not-ready, pending, failed, timeout, or
unreachable; and 64 for invalid arguments.

On a Remote Link Child, readiness also covers the link. While the link cannot carry a request,
`/readyz` answers `503` with `status: "pending"` and `link: {state: "unavailable", reason}`, so
`ocx ready --wait` keeps waiting until the link is back; a working link adds
`link: {state: "available"}` to the `200` answer. `/healthz` on a Child keeps meaning only that the
process runs. The reasons are listed in [Remote Link](/guides/remote-link/#link-status).

### `ocx resolve [--json]`

Resolve the runtime facts a shell needs without re-implementing them: the config home, the
effective port, and the identity-checked liveness verdict. `--json` emits one versioned
document (`schema: "ocx-resolve/1"`) with `cliVersion`, `configHome`, `port`
(`effective`, `configured`, and `source`), and `liveness` (`status`, `pid`, `port`,
`source`, plus `version`, `role`, and `hostname` when the live proxy reports them).
When a proxy is live the document also carries `versionSkew` — the same comparison
`ocx status` and `ocx doctor` surface — with `cliVersion`, `proxyVersion`, `skewed`,
a `relation` of `match`, `cli-newer`, `proxy-newer`, `incomparable`, or `unknown`,
and the operator-facing `warning`. Shells read `relation` rather than reparsing the
warning; the desktop uses `proxy-newer` to keep a takeover from downgrading the listener.
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

The pending-history check reads a checkpointed WAL-mode `state_5.sqlite` even when Codex is
closed and its `-wal`/`-shm` files are absent. Missing sidecars alone do not indicate a history
integrity failure. Backup manifests and restore targets still undergo integrity validation.

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
and pending history migration. The **Native main refresh** section reads admission status from the
running proxy's authenticated, read-only native-main admission endpoint, so a separately launched `ocx doctor`
reports the service's `foreign-ownership` or other fence reason; if the proxy cannot be queried it
reports admission as unavailable. The Codex app-home targeting section also detects the narrow
Windows Orca runtime-home mismatch and explains service migration when applicable. Paths shown by
this diagnostic redact the OS username. Doctor prints repair hints but does not apply them.

Project-config diagnostics ignore provider examples inside TOML multiline strings, including
`developer_instructions`. Real provider and profile settings after the closing delimiter are still
checked, even when an escaped quote immediately precedes that delimiter.

The **OAuth reliability** section reports whether credential storage is writable, whether refresh
single-flight/lock files can be created under `OPENCODEX_HOME`, non-healthy OAuth or Codex pool
accounts (redacted ids) with a recovery `Action:`, and a static OK that the Codex forward path does
not fabricate official-client metadata. Doctor never mutates credentials or applies repairs.

## Catalog sync

### Read saved state separately from synchronization

Model, provider, settings and v2 receipts have different completion contracts.
Local custom-model changes opportunistically sync: no proxy means a successful
save, `needsSync:true`, `sync.status:"not-attempted"` and exit 0. An explicit local
provider `--sync` without a proxy instead returns nonzero after saving.

Settings writes use `catalogRefreshPending`, while live v2/catalog writes use a
full `catalogRefresh` disposition. Local v2 mode/keep-native and changed on/off
still attempt their established sync even when no port was discovered. JSON
reports actual changed state and sync evidence; unverified/failed sync is nonzero.
Threads/hints and unchanged on/off do not introduce a new sync attempt.

Inspect the same target with `ocx v2 status --json` or `ocx v2 status --live --json`,
and use `ocx system settings --json` for settings read-back. A saved-but-pending or
unknown outcome does not prove rollback and is not permission to replay a write.
See [v2 outcomes](/reference/cli/agents/#explicit-v2-target-and-outcome) and
[account policy](/reference/cli/providers-accounts/#pool-policy-account-thresholds-and-paid-credit-intent)
for target, scope and spending boundaries. A reset-grant status read can contact
upstream status but never consumes or resumes a grant.

### `ocx sync [--expect-link <linkId> | --expect-hub-key <apiKeyId>] [--local-only] [--json] [--restart-codex] [--restart-app-server-only] [--child <linkId>]... [--restart-children[=app-server] | --restart-children=codex --yes]` <span id="ocx-sync---restart-codex---restart-app-server-only"></span>

On a Remote Link Home, a successfully committed current catalog is also synced to eligible linked
Children. `--local-only` disables this fan-out. `--json` prints one `ocx.sync.fanout/1` result with
the Home outcome and each Child's state. A connected Child skipped during fan-out includes its reason
and an actionable `hint` in JSON and human output. Update OpenCodex on an older Child to at least
2.93.0 using the installer that owns the selected `ocx`. For a Desktop install on headless Windows,
use **Check for Updates** in the signed-in Desktop tray. A link
mismatch may require re-linking the Child, while an updating Child can be retried after the update.
The Home's own nonzero exit code is returned unchanged. When the Home exits 0, a connected Child
skipped during fan-out, a failed or timed-out Child, a requested Child restart that did not certainly
happen, or an unreadable link store produces exit 6. Intentional skips such as client-initiated links,
`--local-only`, links left out by `--child` (`not-selected`) and Children held by a Child operation
(`child-busy`) keep their existing exit behavior.
An unreadable link store produces a path-free error in human output. Exit 7 is reserved
for an update in flight.
If the Home sync throws in JSON mode, stdout still contains one result document and stderr gives a
sanitized failure message.

Fan-out requests no Codex restart on a Child unless you pass `--restart-children` (app-servers) or
`--restart-children=codex --yes` (the Codex desktop app, which ends live conversations and needs a
signed-in desktop session on that machine). The Home syncs each selected Child first, reads that
Child's activity again, and only then sends the restart as a second pinned sync. It skips the
restart, never the sync, for a Child that is relaying a model request at that moment
(`restart-skipped:link-active`) or whose activity it cannot read (`restart-skipped:activity-unknown`),
for Windows Children (`restart-skipped:windows`) and for `ocx-child` (`restart-unsupported:ocx-child`),
and then exits 6. A link whose Child kind is not recorded still receives the restart flag on that
second sync, which is how the Home learns that it runs `ocx-child`; `ocx-child` ignores the flag. If
the restart could not be sent, or was sent but its result is unknown, the Child's row reads
`restart-not-run` or `restart-result-unknown` and the exit is also 6. As with
`ocx link restart-codex`, this protection is best-effort: a request that starts between that read and
the restart can still be ended. `--child <linkId>` (repeatable) fans out only to those links; the
others are reported `not-selected`. A Child busy with a Child operation such as `ocx link update` is
skipped as `child-busy`. The Child's pinned sync may still restart its own OpenCodex client runtime
after applying changed Home settings. If the Home times out and stops its local SSH process, a remote
sync already running may continue on the Child.

If an update is in flight or the shared update/sync mutex cannot be determined, sync changes nothing, reports `update-in-flight`, and exits 7. When a marker left by an interrupted update in OpenCodex 2.100.x or earlier causes the refusal, stderr also names the marker and its recovery; see [Update Failed](/troubleshooting/update-failed/#if-every-update-and-sync-says-update-in-flight). If another sync holds the mutex, it reports `sync-in-progress` and exits 1; a Home counts that Child as failed and exits 6 when its own sync succeeded. With `--json`, either refusal prints one result document with the Home skipped and the refusal reason in `fanout.reason`.

An explicitly requested restart also runs after a successful committed `config.toml` change, even if the catalog and cache bytes are unchanged. A configuration-only no-op, refusal, preflight, or rolled-back write does not trigger it. Without a restart flag, sync never automatically restarts Codex.

On a Remote Link Child, `ocx sync` also applies the Home's Codex settings and, when the client runtime
started before that apply, restarts it; see [Remote Link apply parity](#remote-link-apply-parity).

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

#### Sync only from the expected Home: `--expect-link` and `--expect-hub-key`

```bash
ocx sync --expect-link <linkId> [--restart-codex]
ocx sync --expect-hub-key <apiKeyId> [--restart-codex]
```

A script that reads `ocx connect status --json` and then runs `ocx sync` cannot tell whether the
machine was disconnected or relinked to another Home in between; a plain `ocx sync` would then
sync the local providers or the other Home's catalog. Passing the identity you read closes that
gap. `--expect-link` takes the `link.linkId` of a Remote Link Child and `--expect-hub-key` the
`apiKeyId` of a hub client. The check runs under the same lock that chooses the sync path, and
every later write is bound to the connection that passed it.

When the identity holds, the command is exactly the connected sync above. Otherwise it changes
nothing (not even the automatic Codex shim repair other commands run first), never syncs the local
providers, exits **5**, and prints a human line followed by one JSON line as the last line on stderr:

```json
{"phase":"child_link_mismatch","reason":"other_link"}
```

`phase` is `child_link_mismatch` for `--expect-link` and `hub_client_mismatch` for
`--expect-hub-key`.

| `reason` | Machine state |
| --- | --- |
| `disconnected` | Not connected to any Home or hub |
| `invalid_state` | The client configuration or a connect marker cannot be read |
| `disconnect_pending` | A disconnect has started and not finished |
| `pending_operation` | A key rotation, a connect, or another sync is in progress (including one that holds the locks this check needs) |
| `hub_client` | `--expect-link` on a hub client |
| `link_client` | `--expect-hub-key` on a Remote Link Child |
| `other_link` / `other_key` | Connected, but to a different link or with a different key |

A missing or malformed value, a repeated flag, or both flags together exit 2 before any state is
read. A connection that changes after the check, while the catalog is being fetched, still fails
as a plain connected sync does (exit 1, nothing written). Versions without these flags ignore
them, so check `ocx --version` first.

### `ocx sync-cache [--restart-codex] [--restart-app-server-only]`

Invalidate Codex's local model picker cache so it is rebuilt from the active opencodex catalog. The
same stale-`app-server` warning and optional restart flags as `ocx sync` apply.

If the derived cache already has identical bytes, the command succeeds without rewriting it or restarting Codex. With `--json`, this is reported as `ok: true`, `wrote: false`, `skipped: true`, and `skippedReason: "unchanged"`; an invalid catalog or failed cache write still exits nonzero.

### Catalog write diagnostics

Catalog write auditing records bounded diagnostics in `opencodex-catalog-audit.jsonl` under
`CODEX_HOME`. An unchanged catalog or cache produces no event; an audit failure does not fail
catalog publication.

On Windows, **at most the successful new-file creation event is recorded**. The file is created
empty and hardened before diagnostic data is written. All later events skip the existing file,
both in the same process and after restart. A hardening failure may leave an empty file, which
later events also skip. Existing files and their ACLs are not changed for auditing, including
when another OpenCodex home owns the catalog. This is a privacy-first fallback, not a complete
Windows audit stream; native NTFS behavior for this audit path has not yet been validated.

POSIX auditing continues to append and retain bounded records. The Windows limitation does not
disable catalog protection or owner healing. Audit files in a separate `CODEX_HOME` remain
cleanup residuals because the config uninstall manifest cannot claim paths outside its own root.

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

A managed service may start a newer installation that previously served the same
OpenCodex home, even when its service definition still points to an older install.
If that newer child exits before binding, with any exit code, the original service starts instead
and applies its own checks before serving.
Foreground starts and client-launched proxies keep their selected executable.
On Windows, this applies to Task Scheduler and newly installed or repaired native WinSW
services. A native WinSW definition created before this behavior needs `ocx service repair`
to refresh its XML before it can hand off to a newer install.

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

The Windows wrapper supports locale dates containing parentheses, including Korean and Japanese
date formats. After upgrading, run `ocx service repair` to replace an older generated wrapper
that exits before launching Bun on those locales.

The Windows wrapper verifies its baked Bun runtime and CLI entry before every start attempt. If an
interrupted package update removed either file, it logs one `installation is incomplete` message and
stops instead of retrying the same missing executable every five seconds. Reinstall opencodex, then
run `ocx service repair` to refresh the task with the restored package paths.

Service definitions omit shell-local version-manager multishell directories from their saved
`PATH`. This includes the native Windows service installed with `ocx service install --native`;
run `ocx service repair` to regenerate an older WinSW definition with a durable `PATH`.

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

The macOS agent uses launchd's `Interactive` resource policy because Codex and dashboard requests
depend on its responsiveness. This avoids the default daemon CPU and I/O throttling under load.
After upgrading an existing installation, `ocx service repair` applies this policy as well.

If launchd refuses the changed definition and its state can be checked, repair reports failure
and attempts to restore the previous definition; a job still serving the expected command is left
running with the previous plist back on disk. A matching command alone cannot confirm the new policy.
If the initial launchd probe cannot check state, repair refuses before writing a new plist or backup.
If state becomes uncheckable after bootstrap, repair keeps the new plist and any backup without another eviction:
a refused bootstrap throws, while an accepted bootstrap reports an unverified reload with a warning.
Inspect the job with `launchctl print gui/$(id -u)/com.opencodex.proxy` before retrying repair.
An unconfirmed definition remains pending across repairs, including after a token change. Registration
is retried only when the initial launchd probe is checkable; a GUI login session may be required.
Repair preserves any original backup successfully created until bootstrap is accepted and the probe
confirms the matching job. Backup creation is best-effort; a fresh installation has no prior definition.
Identical disk bytes and command alone cannot make a pending repair a no-op. Fresh installation
removes orphaned recovery files, and full uninstall removes them even when the plist is absent.
Fresh-install recovery cleanup, pending-marker removal and uninstall cleanup ignore only already-missing
files; another error in these steps reports failure without deleting install state. After a verified
repair has written install state, removing the `.prev` backup is best-effort; failure there does not
change the repair's reported success.

Launchd restarts the proxy after a crash or failed restart handoff, but leaves it stopped when
the service deliberately exits cleanly because the desktop app owns the runtime. Run
`ocx service repair` once to apply this behavior to a service installed by an older version.

Definitions installed before this change do not have the resolved `CODEX_HOME` and `OPENCODEX_HOME`
pinned for service restarts. After upgrading, run `ocx service repair` once so the generated shell
reasserts both homes after login-profile initialization and Task Scheduler keeps absolute home paths
rather than expanding the task's runtime profile variables. Repair also refreshes old versioned paths;
if the old executable was already deleted, reinstall opencodex before repairing. Linux service
starts then follow the launcher; macOS repair writes the new package and home paths into the launchd
definition.
On macOS, install and repair refuse a home or proxy environment value that contains a control
character an XML plist cannot hold (for example U+0001); the error names the variable to fix.
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
| `status` | Report service and proxy diagnostics plus log paths. `--json` prints the passive document described below. |
| `uninstall` | Remove the service and restore native Codex. |
| `remove` | Alias of `uninstall`. |

On Windows, a bare `ocx service` runs the install path only after both Task Scheduler and WinSW are
proven absent. If either status query is inconclusive, it refuses to register anything and asks you
to run `ocx service status`; use explicit `ocx service install` only after confirming absence.

`ocx service status --json` prints one passive document for scripts and peers such as GOAT's device inventory. It runs the same reads as the text report and never installs, starts, stops or repairs anything; `--json` on any other `service` verb is rejected. Fields: `schemaVersion` (1), `platform`, `supported`, `backend` (`launchd`, `systemd`, `schtasks`, `winsw`, or `none` when nothing is registered), `label` (the job, unit, task or WinSW service name), `installed`, `enabled`, `running` (the service manager's verdict), `viable`, `stale`, `conflict`, `serving` (`probed`, `ok`, `port`; probed only when a registration exists), `summary`, `logPath`, `ownershipLease` and `desktopLogin`. An unsupported platform or a Docker container still gets a document, with `supported: false`.

### Runtime ownership

The OpenCodex desktop app can take the background proxy over from a CLI installation. When it does,
it records the handover in the shared service install state, and that record is what makes the
takeover survive a restart. Your service registration is **kept, never deleted** — the record
supersedes it rather than replacing it.

A state file with no ownership record means the CLI installation owns the runtime, which is what
every installation made before this feature is in. Nothing changes for you until an app takes over.

Supervised service children also check the recorded owner before startup and once more while
holding the startup ownership lease, before choosing a port or publishing a PID. If the desktop
app claims the runtime during startup, the service child stands down even if the desktop proxy
has not begun listening yet. An unreadable ownership record has the same stand-down behavior.

Home paths inside a state record are compared with the current home by the physical directory they
resolve to, not just their spelling. A junction or symlink recorded under an older install still
names the same home and keeps working after the move; an alias that no longer resolves is only
treated as a different home when its recorded spelling also differs from the current one, so a
stale mount still produces the foreign-owner refusal instead of silently claiming the runtime.

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

### Service logs

The managed proxy writes stdout and stderr to `~/.opencodex/service.log`
(or `$OPENCODEX_HOME/service.log` with a custom home). When `OCX_SERVICE` is set,
`ocx start` prefixes every console log line, including multiline diagnostics,
with a UTC ISO-8601 timestamp such as `2026-10-14T03:04:05.678Z`.
Foreground output and other CLI commands keep their existing format.

The service checks the log size at startup and once per minute. Above 20 MiB it
copies the newest 20 MiB into `service.log.1`, moves the previous archive to
`service.log.2`, and truncates the active file in place so the service manager's
open append handles remain usable. The active file can exceed the threshold
between checks; each archive is limited to 20 MiB. Rotation failures do not stop
the service. Copy-truncate can lose lines written during the copy, and an archive
may begin partway through a line. Existing Windows wrapper messages keep their
wrapper format.

On macOS this also covers a subtler failure: `launchctl load` reports failure on
stderr while exiting 0, so a load that did not take used to leave launchd running a
**previous** version of the service definition while the command printed a checkmark.
`install` now fails loudly in that case and names the `launchctl bootout` command that
clears the stale job.

On Windows, `ocx service status` reports Task Scheduler registration separately from
identity-verified OpenCodex proxy reachability. It does not print the localized `schtasks` table,
so the summary remains readable across Windows code pages. Transactional-backup recovery
logs a fixed success message rather than the backup directory name; backup names containing
shell metacharacters do not become commands in that log message.

On Windows, uninstalling an elevated-registered `opencodex-proxy` task can require an
elevated terminal. If deletion is denied, or exits with code 1 while the task is still
present, OpenCodex reports the elevation requirement and preserves the service assets.
Open PowerShell or Terminal with **Run as administrator** and run:

```powershell
schtasks /delete /tn opencodex-proxy /f
```

Then rerun `ocx service uninstall` from the original account to finish cleanup, and check
`ocx service status`. Access-denied start/stop commands name their corresponding elevated
`schtasks` command. Scheduler failures use stable diagnostics and exit codes rather than
echoing localized child stderr, which may use a different Windows code page. An absent or
unreadable task after a failed delete keeps exit code 1 alone from confirming an access
denial; recognized access-denied text from the delete is still classified as one.

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

If startup reports `another process owns the runtime mutation lease` or `ocx service status` shows
`Runtime mutation lease busy`, the lease is blocking startup or service changes even if the
proxy is not running. The message includes the lock path, recorded PID, current liveness,
executable name when available, and lease age. The process identity is unverified: the PID
may have been reused, so liveness and executable name describe whichever process occupies
that PID now. Wait for the operation to finish and retry; do not delete the lock or stop a
process based only on this PID. A later mutation attempt can reclaim a stale lease once its
age exceeds 30 seconds and the recorded PID is no longer alive; status only inspects it.

On Windows, this shared Node/Bun diagnostic does not launch an executable to look up the
image name; the recorded PID, liveness, lease age and recovery guidance remain available.

### `ocx codex-shim <install|status|uninstall|remove>`

On macOS and Linux, install a private autostart wrapper at `<OPENCODEX_HOME>/bin/codex` and a
sourceable `<OPENCODEX_HOME>/codex-shell-env.sh`, using the resolved OpenCodex home. The native
launcher stays where brew, npm, or fnm installed it; package-manager upgrades and version rollbacks
continue to work without rewrapping that launcher. On Windows, script-based launchers are still
wrapped in place. Real `codex.exe` targets are left untouched.
If installation is refused or the wrapper cannot run, the command exits nonzero and the dashboard
reports the failure reason. A runnable Unix wrapper counts as a successful install even before
activation in the current shell; an already-installed healthy shim also counts as success.
For Windows installations that expose only `codex.exe`, use `ocx service install` for autostart.

On macOS/APFS, a reboot can change filesystem device numbers. An unchanged private wrapper and
shell environment remain owned after that change, so status, repair, and uninstall continue to
work. OpenCodex still checks their recorded inodes, paths, owner, permissions, and content/launcher
binding; replaced or unvalidated files are preserved.

After brew/fnm and other PATH setup, run the activation command printed by install. With the default
home, it is:

```sh
. "$HOME/.opencodex/codex-shell-env.sh"
```

For a custom home, use the printed, quoted path. Sourcing is idempotent: it removes duplicate private
bin entries and puts that directory first on PATH. To activate future shells, add that source line
after your package-manager PATH setup yourself; OpenCodex never edits shell startup files. Install
cannot change its parent shell. `ocx status`, `ocx codex-shim status`, `ocx doctor`, and `ocx connect`
report a runnable but unselected wrapper as **not active**, with the activation command. Shell
aliases/functions and separately configured desktop or service launchers still need their own setup.

For fnm-managed Codex, installation resolves the temporary multishell directory to the durable
Node installation while preserving the launcher filename. If that directory cannot be resolved,
installation refuses instead of wrapping a temporary path. When Codex is selected, `ocx connect`
also reports shim readiness. This readiness check skips special-file PATH entries and, on macOS
and Linux, files without execute permission, including symlink targets. It preserves the order of
regular executable launchers, including npm and fnm symlinks. Windows keeps its PATHEXT lookup.
If a different PATH wrapper hides a runnable shim, fix PATH order;
reinstalling the same shim does not change which command your shell finds first. If the tracked shim
is runnable but no `codex` command is found, connect reports it as inactive and prints the activation
command. A failed PATH inspection reports activation as unverified instead of claiming
that no command exists. These warnings do not change the connect command's exit status.

Before an install or repair is committed, OpenCodex runs the saved launcher with `--version` while
service startup is bypassed. It refuses the change and rolls back when the launcher resolves
`codex` back to the shim, exits nonzero, exceeds five seconds, leaves descendants running, or
cannot be validated and cleaned up safely. Therefore `codex-shim install` is not unconditional. If
it is refused, reinstall Codex so the PATH entry is a concrete executable or launcher and retry;
use `ocx service install` instead when a dynamic command-manager launcher cannot meet these checks.
Cleanup refusals include a bounded diagnostic suffix identifying the probe phase, a recognized
native error code or signal, and the exit status when known. It does not include launcher paths
or raw child output, and does not relax the validation or rollback checks.
An older Unix shim installed in place is migrated only by an explicit `ocx codex-shim install`.
Migration restores the recorded native launcher without replacing a newer launcher already present,
then installs the private wrapper. If private installation fails after native restoration, the native
launcher stays restored and the operation can be retried. Missing or unusable native launchers require
package-manager repair; OpenCodex does not guess another installation or rewrap the manager's path.
Migration also refuses when the recorded `codex-shim.json` is not a regular file owned by you or is
group- or world-writable. Older releases wrote that file with the process umask, so a umask of `002`
left it at mode `0664`. The refusal names the file and the `chmod 600` that clears only the
group- or world-writable refusal. Symlink and foreign-owner refusals remain; OpenCodex does not
change the permissions itself.

Launcher installation alone does not prove that Codex requests will use OpenCodex. After a runnable
install, the command checks the current Codex routing and reports a warning instead of a green result
when routing is external, user-owned, or unverifiable. It also warns when outbound proxy variables
exist only in the current process while `config.proxy` is unset or unresolved, because Codex
launchers and background services may not inherit that environment. These checks are read-only and
never print proxy values; resolve the reported handoff and run `ocx doctor` before relying on
autostart.

On Unix, automatic repair refreshes only the private wrapper and never rewrites package-manager
launchers or migrates an older in-place shim. On Windows, if a completed external Codex update
overwrites an installed shim, the next ordinary `ocx` command backs up the stable new launcher
and restores the shim before dispatch. The zero-effect
`ocx system codex-cli-update check` inspection command and malformed invocations in its reserved
`ocx system codex-cli-update` namespace never perform that repair. `ocx status`, `ocx doctor`, and
`ocx codex-shim status` also skip shim auto-repair and report the observed state.
A launcher that is still changing is left untouched and retried later. Repair failures warn without failing the requested
command; manual fallback: `ocx codex-shim install`. Set `codexShimAutoRestore` to `false`, or set
`OPENCODEX_CODEX_SHIM_AUTO_RESTORE=0` for a process-level opt-out.

The Unix wrapper retains its recorded native launcher path. Package-manager changes behind that
durable entry are followed automatically; removing that entry requires package-manager repair.
Dynamic command-manager launchers still have to pass the validation above. Windows in-place repair
needs the saved original beside the shim; if a version manager destroys the whole tree and backup,
OpenCodex reports the condition and stops instead of inventing a replacement original.

If your version-manager launcher cannot pass validation, route through Codex configuration instead of the
launcher: `ocx start` writes `openai_base_url`, and `ocx service install` provides autostart. Run
`ocx status` to confirm — it reports the active routing, and warns when a running proxy is not the
one Codex is pointed at.

| Subcommand | Action |
| --- | --- |
| `install` | Install the shim (or repair if stale). |
| `uninstall` | Remove private Unix artifacts, leaving native Codex untouched; on Windows, restore the original launcher. |
| `remove` | Alias of `uninstall`. |
| `status` | Report shim state and whether the private wrapper is active on PATH. |

```bash
ocx codex-shim install
ocx codex-shim status
ocx codex-shim uninstall
```

After Unix uninstall, remove the source line from your shell startup file and restart the shell or
remove the private bin entry from its PATH. Uninstall removes the owned wrapper, shell environment
file, and state; it leaves the package-manager launcher untouched. An older in-place Unix shim is
released using its recorded restoration data.

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

Unix package-manager upgrades leave the private wrapper intact. A runnable wrapper that is **not
active** does not inject the token: source the printed activation file in the launching shell.
On Windows or with an older in-place shim, a Codex upgrade that replaces the launcher removes the shim;
on Windows the next ordinary `ocx` command restores
it (see above), but a `codex exec` that runs before that fails. `ocx doctor` reports this exact
state under "Codex env_key launch readiness" (env_key configured, variable unset, shim missing or
unhealthy, token file present) with repair or activation guidance, and never prints the token. Reading the token
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

Open the [web dashboard](/guides/web-dashboard/) at `http://127.0.0.1:<port>` — or at
`http://127.0.0.1:<management port>` when hub management ingress is enabled — auto-starting the proxy
if it is not running.

## Updating

`ocx update` updates OpenCodex itself; it does not update the Codex CLI. Use the
[system inspection commands](/reference/cli/agents/) to inspect the configured Codex CLI candidate
with bounded, read-only provenance inspection. `ocx system codex-cli-update check` does not query a
package registry or install an update.

### `ocx update [--tag latest|preview]`

#### Orchestrated update

Automation can discover support with `ocx capabilities --contracts --json`; the
`contracts` array contains `update.orchestrated/1`. The contracts-only option
cannot be combined with `--route` or `--mutating-only`.

```bash
ocx update --plan --json [--tag latest|preview | --version <version>]
ocx update --yes --json [--version <version>] [--expect-plan <token>] [--not-after <unix-ms>]
```

Plan emits one `ocx.update.plan/1` JSON object: `currentVersion`, `targetVersion`,
`installer`, `runtimeOwner`, `servingPath`, `cliPath`, `canApply`, optional `reason`,
`restartRequired`, `planToken`, `updateInFlight`, and `mutationBoundMs`. A plan is
read-only. Reasons are `desktop-app-owned`, `source-checkout`, `mise-managed`,
`installer-unknown`, `plan-unavailable`, `serving-install-unknown`,
`cli-not-serving-install`, `runtime-ownership-refused`, `target-unresolved`,
`downgrade-refused`, and `up-to-date`. `desktop-app-owned` directs updates to the
Desktop app; uncertain serving identity refuses rather than guessing. Run `ocx start`
or `ocx stop` to settle a stale runtime record before planning again.

Apply emits one `ocx.update.result/1` object with `applied`, `fromVersion`,
`toVersion`, `installer`, `restarted`, `healthy`, `rolledBack`, and an optional
`error`. Pass the plan's `planToken` as `--expect-plan` to refuse with
`plan-changed` if the selected install or runtime identity changes. `--not-after`
is a positive safe integer Unix timestamp in milliseconds; mutation is refused with
`deadline-passed` after that time. `mutationBoundMs` is 900000 (15 minutes): an
overrun reports an uncertain result without killing an in-progress transaction.
`updateInFlight` remains true while an update may still mutate, including when its
state cannot be determined; a sync alone does not set it. A concurrent sync can
refuse apply with `sync-in-progress`, and another update with `update-in-flight`.

Orchestrated apply exits 0 when verified or already up to date, 10 on refusal,
11 when the update failed but the previous version is verified active (including
the runtime when required), 12 when the outcome is unverified or still running,
and 64 for invalid usage. `rolledBack` is true only when an actual installer
rollback and its verification succeeded. A plan command emits its plan with exit 0;
the `canApply` and `reason` fields describe eligibility.

Compiled standalone installs, including the Windows MSI Desktop bundle, are updated through **Check for Updates…** in OpenCodex Desktop, or by reinstalling the standalone binary from [GitHub Releases](https://github.com/lidge-jun/opencodex/releases). `ocx system update check` reports `installer: "standalone"`, `canUpdate: false`, and `reason: "standalone_install"` with that guidance. `ocx update` exits unsuccessfully with the same hint; it does not run a package-manager update for the compiled executable. A genuine source checkout still reports `installer: "source"` and `reason: "source_checkout"`.

When OpenCodex is installed through mise, this command exits unsuccessfully before stopping the proxy or changing package files and shows `mise upgrade <tool>`, using the verified local mise alias. Update checks remain available and report the installation as externally managed. An unreadable or inconsistent mise ownership record fails closed without guessing a tool name, and `--tag preview` never changes mise's configured selection.

On Linux, a background service whose recorded launcher is mise's package launcher (`<tool>/latest/node_modules/.bin/ocx`, not a mise shim) follows `mise upgrade` by itself: within about ten seconds of the new version settling, it drains active requests and restarts onto it, and it recovers the same way if mise later prunes the version it was running. On macOS, for a service installed through a mise shim, and for a foreground proxy, restart it yourself after upgrading (on macOS, `ocx service repair` first).

Self-update opencodex from npm. Stable installs use `@latest`; preview installs stay on `@preview`
unless you pass `--tag latest|preview`. It detects a source checkout and tells you to
`git pull && bun install` instead, and is a no-op if you are already on the newest version for that
tag. Before stopping anything, npm installations run a bounded Unix cache ownership and access
check. Nested symlinks are checked with `lstat` but not followed; Windows explicitly skips this
Unix-only check. A failure aborts while the tray and proxy are still running.
For Bun installations, `ocx update` runs an early configuration preflight before stopping the proxy:
if `config.json` cannot be read (including dangling symlinks) or requires diagnostics fallback or salvage,
the update aborts with exit code 1 while the service and tray continue running. For a readable
but invalid file, run `ocx config validate` to diagnose it, then back up and correct the file.
Validation does not change the file. For an unreadable or non-regular entry, inspect the config
path, permissions, and any symlink target; correct them or restore a readable regular config from
a trusted backup before retrying. Validation may report defaults when a symlink target is missing,
so its success alone does not resolve that condition. Reparable configurations do not abort. A running proxy is
then stopped before files are replaced; an installed service is rebuilt and started automatically,
while a foreground installation prints `ocx start` as the next step. Dashboard update records
redact profile/cache paths and UID/GID values before they are persisted.
When a stopped listener's literal IP address drops the liveness dial instead of refusing it
(for example on a tailnet), the updater briefly tries binding that same address and port.
A successful bind confirms absence at that instant; a failed bind or an inconclusive hostname
probe still prevents the update.

On Windows, Scoop's default `nodejs` and `nodejs-lts` `npm` installations can be used
from the user home directory when their `current` junction stays inside the Node app
directory; the default persistent `bin` directory is also supported. Running inside
that installation (including its resolved version directory or persistent `bin`),
project-local `npm`, `NO_JUNCTION` version-directory entries, and custom Scoop roots
under the home remain excluded.

If the install step fails, the previous version stays installed and its service is restarted; the
terminal output names the next step, and [Update Failed on Windows](/troubleshooting/update-failed/)
covers finishing the update and the folders a failed attempt can leave behind.

```bash
ocx update
ocx update --tag preview
```

New versions become available when the [Release workflow](https://github.com/lidge-jun/opencodex/actions/workflows/release.yml)
publishes them to npm.

## Save cleanup thresholds without starting a cleanup

```bash
ocx storage policy show --json
ocx storage policy set --archived-bytes-over 1073741824 --reduce-to-bytes 536870912 --json
ocx storage policy show --json
```

The setter writes nested `trigger.archivedBytesOver` and one target. Byte values
are safe nonnegative integers. Alternatively choose `--remove-oldest-percent 10`
or legacy `--percent 10`; the two percentage flags and reduce-to are mutually
exclusive. CLI percentages are integers with server-supported range 1–100.
Omitted `--enabled` leaves the stored value unchanged; explicit values are `true`
and `false`. Set does not run cleanup, but an already-enabled schedule remains
in force. Do not add enable or an immediate policy run unless intended.

The new-field receipt is `{ok:true,policy,job:{status}}`, with observed trigger,
target, mode, schedule and optional last/next-run facts. `job.status` describes an
existing idle/running state, not a cleanup started by this command. Read back on
an unknown outcome rather than replaying the write.

## Remote Link apply parity

A Remote Link Child applies its Home's OpenCodex-owned Codex settings when it is linked
(`ocx link add` on the Home) and on every `ocx sync`. Three facts let a peer check that the
Child really runs under the settings it applied, without reading either machine's configuration.

`ocx status --json`, on any device, carries:

| Field | Meaning |
| --- | --- |
| `appliedCodexSettingsDigest` | Lowercase hex SHA-256 of the applied settings (below). On a Child, the values its last recorded apply wrote. On a Home or standalone install, the settings document it serves its Children right now, computed from its current configuration. `null` on a hub client, on a Child with no recorded apply, and on a Child whose apply of changed settings is in progress or failed (the previous digest is withdrawn first, so it is never reported for values Codex no longer has). |
| `lastApplyAt` | Child only: epoch milliseconds of the last successful apply that changed the applied settings. Re-applying the same values is not a new apply and keeps it, so an unchanged `ocx sync` never forces a restart. `null` elsewhere. |
| `runtimeStartedAt` | Child only: epoch milliseconds the running client runtime started. `null` when no client runtime answers. |

The digest is computed over this compact UTF-8 JSON, with the keys in exactly this order and no
whitespace, from the values actually applied:

```json
{"version":1,"settings":{"fastMode":true,"multiAgentMode":"v1","webSearchSidecarEnabled":false,"subagentDefaults":null}}
```

`subagentDefaults` is `null` when unset, otherwise `{"model":…,"reasoningEffort":…}` in that order.
The example above hashes to `57c751eff89844f93db71a6ee4acdac03afbc29fec52734ade80a40193e826cd`. The digest
never contains a setting value, and the Home's name and version are not part of it, so a Home and
a Child that applied the same values report the same digest.

On the Home, every row of `ocx link status --json` carries what that Child last reported:
`lastApplyAt`, `runtimeStartedAt`, `appliedCodexSettingsDigest` (same meanings as above) and
`reportedAt` (epoch milliseconds, the Home's clock). A linked Child reports shortly after its runtime
starts and then once a minute; the Home keeps reports in memory only, so after a Home restart the
fields read `null` until the next report. A Child whose runtime started before `lastApplyAt` is
running an older runtime than its last apply.

With a Home and CLI that support it, each row also carries a `child` block: the Child's running and
installed versions, its version skew against the Home, its update route, whether it last downloaded the
Home's current catalog, whether a relayed model request is running, and the last operation. Installed
version and update route come from `ocx link check (--link-id <id> | --all) [--no-wait] [--json]`, which
runs the Child's `ocx update --plan` over SSH for each Home-initiated link (60 seconds per Child, three at
a time) and changes no install. A POSIX Child older than 2.97.0 gets one more read-only SSH call for its
version; a Windows Child that old reports the version it sent over the link. The fields are described in
[Home and Child versions](/guides/remote-link/#child-install-catalog-and-activity).

Lightweight `ocx-child` Child hosts run `ocx-child sync [--expect-link <id>] [--json]`, `ocx-child status [--json]` (while `ocx link status --json` remains on the Home), and `ocx-child disconnect` / `ocx-child detach`: on an attached `ocx-child` host (which runs without a system service manager), a successful `ocx-child sync` starts `ocx-child serve` if no relay is running even when settings are unchanged, rolls it over when `runtimeStartedAt < lastApplyAt`, and posts a best-effort parity report on non-stale syncs. `ocx-child sync` accepts `--restart-codex` / `--restart-app-server-only` for flag compatibility without restarting Codex processes (restart the Codex desktop app and long-lived `app-server` processes separately if needed), and `ocx-child disconnect` / `ocx-child detach` restores `~/.codex` files offline and stops `ocx-child serve` with zero background daemon left running. Only one `ocx-child` install may manage a given `CODEX_HOME` at a time: lifecycle commands lock `CODEX_HOME/.ocx-child.lock` (kept permanently) and record the owning `OPENCODEX_HOME` in `CODEX_HOME/.ocx-child-owner.json` until `ocx-child detach` completes, so an `ocx-child attach` or `sync` from a different `OPENCODEX_HOME` sharing that `CODEX_HOME` exits nonzero without changing any file and names the owning home to detach first.

## Child operations from the Home

```text
ocx link update (--link-id <id> | --all) --yes [--no-wait] [--json]
ocx link sync (--link-id <id> | --all) [--no-wait] [--json]
ocx link sync --link-id <id> (--restart-app-server-only | --restart-codex --yes) [--no-wait] [--json]
ocx link restart-codex --link-id <id> [--scope app-server|codex] --yes [--no-wait] [--json]
```

These commands start one job on the Home for Home-initiated Children and print it as an `ocx.link.child-job/1` document: `{schema, jobId, op, trigger, restart, state, createdAt, finishedAt, items}`. Each item carries `linkId`, `alias`, `state`, `reason`, `startedAt` and `finishedAt`, and where they apply `hint`, `fromVersion`, `toVersion`, `sync` (`{state, reason}`) and `restart` (`{requested, outcome}`, where `outcome` is `requested`, `unsupported`, `not-run` or `skipped`). What each command runs on the Child, the version floors and the Windows and `ocx-child` limits are in [Operating Children from the Home](/guides/remote-link/#operating-children-from-the-home). A restart names exactly one link; `update`, `restart-codex` and `--restart-codex` need `--yes`.

| Exit | Meaning |
|---|---|
| 0 | every item `succeeded` or is `up-to-date`, and every requested restart went out; with `--no-wait`, the job was accepted and may still be running (read it again for the result) |
| 6 | an item is `busy`, `offline`, `refused`, `owner-action` or `unsupported`, or succeeded with a reason such as `restart-skipped:link-active` or `post-update-sync-failed` |
| 1 | an item `failed` or is `uncertain`, an item state this CLI does not know, the job did not finish within its wait, or a Home not bound to loopback |
| 2 | invalid arguments, for example a restart with `--all` or `update` without `--yes` |
| 4 | an unknown link, or a Home without Child operations |
| 5 | another operation holds the link, the only link named was started from the Child, the Home has no links, or the command ran on a Child; the error message names which |

The wait does not count time an item spends queued behind another job. Removing a link while a job holds it answers `409 link_operation_in_progress`.

## Child policy from the Home

```text
ocx link policy [--updates off|notify|auto-when-idle] [--catalog-fanout auto|manual] [--child-codex-restart never|app-server-when-idle] [--idle-after-minutes <1-60>] [--json]
```

`ocx link policy` starts no job and prints no `ocx.link.child-job/1` document. It reads the Home's Child policy and, with flags, changes only the settings named: `--catalog-fanout auto|manual`, `--child-codex-restart never|app-server-when-idle`, `--updates off|notify|auto-when-idle` and `--idle-after-minutes <1-60>`. It prints one line per setting, or `{policy, warning}` with `--json`; `warning` is `policy-file-invalid` when the file is damaged, and automatic catalog fan-out and updates stay off; a save keeps every setting it does not name off, so pass `--catalog-fanout auto` and an `--updates` mode to turn them back on. Catalog fan-out is on by default: after a Home catalog change the Home syncs eligible Children over SSH on its own. See [Automatic catalog fan-out and the Child policy](/guides/remote-link/#automatic-catalog-fan-out-and-the-child-policy). Exit codes: 0 on success, 2 for invalid arguments, 4 for a Home without this command, 5 for a conflict answer (`runtime_role_client` from a runtime that is a Child), and 1 for a Home not bound to loopback, an invalid answer, or a run on a Remote Link Child, which refuses the request before sending it.

## Remote Link SSH capture

```text
ocx link capture start [--minutes <1-60>] [--json]
ocx link capture stop [--json]
ocx link capture status [--json]
```

These commands manage a short local window, 15 minutes by default and 60 at most, in which this machine's Remote Link tunnels run SSH with `LogLevel=DEBUG1` and store a sanitized copy of what SSH reports under `<OPENCODEX_HOME>/link/ssh-capture/`. They run on a Home or a Child, need no running proxy or admin token, and print the capture status: `{enabled, logLevel, startedAt, expiresAt, directory, retentionHours, maxMinutes, maxFileBytes, files, removed}`. `stop` ends the window and keeps the files; `status` and `start` delete files 72 hours after their last write and report how many they removed. What is stored and how it is redacted is in [Capture SSH diagnostics](/guides/remote-link/#capture-ssh-diagnostics). Invalid arguments exit 2.

## Remote Link Child attestations

A peer that sends work through a Remote Link Child can check two more facts in the Child's
`ocx status --json`. Both fields are omitted, never `null`, when they cannot be proven.

| Field | Meaning |
| --- | --- |
| `localCredentials` | `{count, generation}`. `count` is the number of provider credentials this installation stores on this machine: OAuth accounts, provider API-key slots (including disabled entries and keychain or environment references), Codex account-pool records, the native Codex `auth.json` and inactive native Codex profiles. Link keys, management tokens and incoming API keys do not count, and neither do the accounts a Home serves. `generation` is opaque and changes whenever a stored credential is added, replaced or removed, even when the count ends where it started. Reported only while an OpenCodex runtime on this machine is running and every store reads completely. A native Codex configuration whose `cli_auth_credentials_store` is not `file` omits it. |
| `link.connectionGeneration` | On a Child: opaque, and changes whenever the tunnel to its Home connects (including a reconnect that keeps the same link) and whenever either runtime restarts. Reported only while the Child's runtime is ready. For a link started from Home, the Child learns it from the Home's signed answer, so a Home on an older release leaves it out. |

A Child that reports `localCredentials.count` 0, with `localCredentials.generation` and
`link.connectionGeneration` unchanged across a request, had no local provider credential during it
and observed no tunnel reconnect.

For a link the Home added, each row also carries `tunnel`: `attempt` (ssh attempts since the link
was last connected), `nextRetryAt` (ISO time of the next scheduled retry, `null` while one runs or
none is due), `lastTransition` (`{from, to, at, cause}`) and `lastFailure` (`{cause, at}`). A cause
is one of `auth`, `hostkey`, `forward`, `remote_forward_conflict`, `timeout`, `network`,
`unknown`, `spawn_failed` and `listener_unavailable`. The Home keeps it in memory, so it starts
empty after a Home restart. `GET /api/link/status` includes the field only when asked with
`?diagnostics=1`, because an older `ocx link status` rejects fields it does not know.

That history survives a restart only in the bounded diagnostics file.
`ocx link diagnostics [--limit <n>] [--since <iso-time|epoch-ms>] [--json]` reads it on the
computer that wrote it, Home or Child, without a running proxy and without writing anything; see
[Remote Link](/guides/remote-link/#retryable-503-diagnostics).

After `ocx sync` applies the Home's settings on a Child, it restarts the Child's client runtime when
that runtime started before `lastApplyAt`, using the same restart as `ocx restart`. A runtime that
already started after the apply is left alone, on a full `ocx` Child nothing is started when no client runtime is
running (unlike an attached `ocx-child`, which starts `ocx-child serve` when absent), and on a full `ocx` Child a failed restart exits nonzero while the previous runtime keeps serving (whereas on `ocx-child`, rollover stops the prior `ocx-child serve` before binding the replacement, so a failed rollover exits nonzero with no relay running until `ocx-child sync` or `ocx-child restart` retries). Two applies on one Child never interleave. On a full `ocx` Child, a second `ocx sync` while one is
applying fails fast and changes nothing. On `ocx-child`, a second `ocx-child sync --expect-link <id>`
(the form the Home's sync fan-out runs) exits `5` with reason `pending_operation` and changes
nothing, while a plain `ocx-child sync` waits for the first apply to finish and then runs.

## Forced link revoke and remote recovery

Only when skipping remote cleanup is explicitly intended, use the actual selected
link ID (`lnk_0123456789abcdef` below is fictional):

```bash
ocx link revoke --link-id lnk_0123456789abcdef --force --yes --json
```

`--force` requires `--yes`; `--yes` alone is invalid. Ordinary revoke is unchanged.
A forced success returns `{linkId,remoteCleanup:"skipped",recovery}`. Idempotent
link-not-found instead reports `remoteCleanup:"unverified"`. Both can exit 0;
these facts derive from CLI intent, not a server cleanup report. Neither means
remote disconnect was attempted or confirmed. Follow the recovery instruction,
`ocx disconnect` on the remote client, when that action is authorized.

## Observe Remote Workspace from the Hub

```bash
ocx remote-workspace hub status --json
ocx remote-workspace hub runtimes --json
ocx remote-workspace hub sessions --json
```

These fixed management reads are separate from executor-local
`ocx remote-workspace status`. Runtime availability is a keyed object; an available
Hub with no devices/sessions is empty success. Disabled Hub observation can arrive
as HTTP 200 with `available:false` yet exits 1; it is not empty success. Inner
HTTP 409 exits 5. Reads never enroll devices, create sessions or submit prompts.
See [Hub observation and recovery](/guides/remote-workspace/#inspect-the-hub-without-starting-a-session).

## Remote Hub client lifecycle

Use `ocx connect <url> --pairing-code-stdin`, `ocx connect status`, `ocx sync`, and `ocx connect rotate --pairing-code-stdin`. The initial catalog download fails after five seconds without incoming bytes, but active transfers may run longer; use `--catalog-timeout <seconds>` (1–120) to override that inactivity window. `ocx disconnect` restores local state offline and does not revoke the hub key. While connected only, `ocx connect revoke --admin-token-stdin` revokes the persisted `apiKeyId`; after disconnect use the hub's **Connect → API Keys** page. Secrets are stdin-only and never belong in argv.

On a Remote Link Child, `ocx connect status` also prints a `Link tunnel:` line (`up`, `down (<reason>)` or `unknown (<reason>)`) read from the running Child's `/readyz`, and `--json` adds `linkTunnel`. `Connection: connected` still means only that the machine is linked; see the [Remote Link guide](/guides/remote-link/).

## Setup port validation

`ocx init` accepts TCP ports 1–65535 as decimal whole numbers. Press Enter to use 10100. Invalid input such as `0`, `10100oops` or `1.5` is never silently replaced or truncated; setup reports it and asks for the port again.

## Login registration diagnostics

On Linux, `ocx service install` checks `loginctl show-user <current-user> -p Linger` before printing boot advice. Enabled linger is reported as already enabled. Disabled linger gets the `loginctl enable-linger $USER` hint; missing or unreadable diagnostics state the uncertainty and do not fail installation.

On macOS, `ocx service status` distinguishes a loaded Desktop login item from a valid enabled registration awaiting the next login. `ocx status` credits the latter in restart safety when the same Desktop app currently supervises the proxy. An incorrect plist label or command, a disabled entry, an unverified load probe, or changed process identity still cannot earn protection.

## Custom Codex provider consent

`ocx codex-provider status` lists the provider IDs approved for the selected Codex home.
`ocx codex-provider allow <id>` asks before allowing URL-only management on start/sync;
`--yes` is explicit noninteractive consent for that named provider.
`ocx codex-provider revoke <id>` restores an unchanged managed URL and revokes permission.
These commands are local and do not require a running proxy. See
[custom provider routing](/guides/codex-integration/#opt-in-a-custom-provider-to-managed-local-routing)
for eligibility, restore behavior and transport preservation.
