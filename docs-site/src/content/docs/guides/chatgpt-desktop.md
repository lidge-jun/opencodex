---
title: ChatGPT Desktop integrations (experimental)
description: Opt-in macOS cloud networking, recovery and the app-server shim.
---

These integrations are independent and default off. Cloud networking preserves TLS;
the app-server shim filters selected fields in the local app-server's output.
Enabling one never enables another.

## Built-in cloud networking

OpenCodex can forward the desktop's encrypted connection to
`codex-cloud-backend.chatgpt.com:443` through its existing outbound proxy.
The feature is macOS-only and opt-in through `chatgptDesktop.cloudNetwork`.
It needs no Developer ID, separate application, Network Extension, local CA,
or desktop bundle modification. It does require administrator-approved
management of this one hostname's hosts mapping and resolver-cache invalidation.

**This changes resolution for all OS-resolver clients of that hostname, not only
the desktop app.** Preserve any working interim route until a separately authorized
real-machine acceptance verifies port 443, DNS caching and authenticated desktop use.

### Install, enable and inspect

Use an updated OpenCodex installation. These are real system operations, not test commands:

```bash
ocx chatgpt network install
ocx chatgpt network enable
ocx chatgpt network status
```

Installation asks for confirmation and then administrator permission through sudo.
`--yes` skips only the initial confirmation, not OS authorization.
It installs an OpenCodex-owned recovery helper and leaves routing off. It does not
restart the proxy or desktop. The helper is internal implementation, not a separately
configured proxy: its launchd job owns only the fixed mapping and resolver recovery.
The network relay, outbound proxy selection, configuration and lifecycle belong to OpenCodex.

`enable` requires the running server and calls its authenticated local management
API. It saves `chatgptDesktop.cloudNetwork: true`, leaving the other desktop flags
unchanged, and starts the integration immediately. Subsequent proxy starts read that flag.
An activation failure remains visible as configured-but-unavailable and returns failure;
it does not stop the model proxy or silently report success.

For configuration-file users:

```json
{
  "proxy": "http://127.0.0.1:8123",
  "chatgptDesktop": {
    "cloudNetwork": true
  }
}
```

Use your existing proxy setting; there is no separate cloud proxy-port configuration.
The same proxy/environment precedence as other OpenCodex transports applies, including
HTTP(S) CONNECT and SOCKS5. A missing proxy, a matching NO_PROXY bypass or a local-443
proxy loop refuses activation. There is no direct fallback through the mapped hostname.

The runtime binds IPv4 and IPv6 loopback port 443 and verifies CONNECT acceptance before
requesting the mapping. An occupied or unavailable listener port leaves the mapping off.
Status distinguishes intent, active runtime and failures; `applicationHandshake`
remains `unverified`. Active forwarding is not proof of a logged-in cloud session.
`ocx chatgpt status` includes cloud status, and a cloud-only `ocx chatgpt launch`
requires that runtime to be active.

### Disable, recover and remove

```bash
ocx chatgpt network disable
ocx chatgpt network recover
ocx chatgpt network uninstall
```

Disable saves the flag as false and removes the owned mapping before closing listeners.
Recovery also disables intent and retries any incomplete mapping/cache cleanup.
If cleanup fails, the off flag is saved but status remains unavailable. Repeating disable
retries recovery; it does not report success solely because the flag is already off.
When the proxy is stopped, these commands can still save disabled intent and contact
the helper; an unavailable helper reports unverified recovery, never successful cleanup.
An active lease from another runtime is not revoked.

The helper holds the mapping only while its connection to the OpenCodex runtime exists.
Runtime death closes that connection and triggers recovery. The helper's launchd
configuration requests restart and boot startup; each new helper process restores the
journal before accepting a new lease. There can be a recovery interval after helper death
or a reboot: no instantaneous recovery or authenticated reconnection guarantee is claimed.
Recovery preserves unrelated hosts lines and refuses edited owned blocks for inspection.

Uninstall requires disabled routing, restores any remaining owned mapping, stops only
the cloud helper and removes its fixed files. It does not stop the model proxy.
`ocx chatgpt restore` confirms cloud recovery before its desktop relaunch, even when
the flag is already off but the recovery helper is still installed;
use `network recover` for an abandoned mapping when no desktop is installed.
A helper update is explicit: disable, run `network install` again, then enable.
Ordinary proxy updates do not execute a hidden administrator operation.

Source/npm installs bundle the small helper and copy their Bun runtime into the
root-owned installation. Standalone builds copy their executable and use its hidden
helper entry. launchd never runs code from a user-writable checkout or package tree.

### Isolated development validation

The cloud-network tests exercise the same runtime and recovery helper with temporary
hosts files, Unix sockets and ephemeral listener ports. They cover TLS forwarding,
process loss and journal recovery without installing a service or changing system routing.
There is no separate sandbox command or native system-extension implementation to maintain.

## App-server shim

This experiment is **macOS only and off by default**. It filters the bundled ChatGPT
app-server's JSON-RPC stdout to open known plain-quota gates. It does not increase
an account's quota or make an upstream service accept a request it refuses.

Enable it in your OpenCodex `config.json`:

```json
{
  "chatgptDesktop": { "appServerShim": true }
}
```

Then run:

```bash
ocx chatgpt launch
ocx chatgpt status
```

`launch` creates an executable launcher under the OpenCodex config directory,
quits ChatGPT if it is running, and relaunches it with
`open -a <bundle> --env CODEX_CLI_PATH=<launcher>`. The app is found by its bundle
identifier, `com.openai.codex`, so an install in `~/Applications` or on another
volume works, and another app that shares the "ChatGPT" name is never quit or
opened. Save ongoing work first: this
restarts the app. It does not require a running OpenCodex proxy.

To remove the launcher and relaunch without the override:

```bash
ocx chatgpt restore
```

Restore leaves the config flag as configured. Set `chatgptDesktop.appServerShim`
to `false` or remove it to disable future explicit shim launches. Normal launches
from Dock or Spotlight do not apply the shim automatically.

If ChatGPT is not installed (no `com.openai.codex` bundle is found), `restore`
only removes the launcher: it cannot relaunch anything and exits with an error.

## Rewrite boundary

Only `account/rateLimits/updated` notifications and responses whose top-level
result contains `rateLimits`, `rateLimitsByLimitId`, or `ordinaryUsageAllowed`
are eligible. Plain `rate_limit_reached` markers are cleared; known quota gate
flags (`allowed`, `limit_reached` / `limitReached`, `ordinaryUsageAllowed`) are
opened only with plain-quota evidence (a cleared plain reached type or a window at
100%). A flag closed for a reason the payload does not show stays closed. Workspace,
credit, unknown reached-type and spend-control
restrictions keep the usage gate closed.

Displayed usage stays honest: percentages, reset times, window durations, plan
information and other display fields stay as received. Unrelated JSON-RPC
messages, nested tool output, conversation send-block metadata and malformed
lines pass through. Only changed lines are serialized again; other bytes retain
their original encoding and line endings. Stdin, stderr and the real binary's
exit status retain their direct connection to the app.

## Executable and environment security

The generated launcher has mode `0755` and embeds the current OpenCodex executable
and, for source installs, the CLI entry path. `CODEX_CLI_PATH` tells ChatGPT to
execute this launcher instead of its bundled binary directly. Keep the launcher,
its config directory, and the OpenCodex installation under your control: changing
these executable paths changes code the app runs. The launcher still `exec`s the
bundled binary of the discovered bundle; if that bundle has no app-server binary,
`launch` refuses instead of writing a launcher.

Before writing the launcher, `launch` also checks that the bundle and its
app-server binary are owned by you or root, are not writable by group or others,
and pass strict code-signature verification under OpenAI's team ID
(`2DC432GLL2`). A bundle that fails any of these checks is refused, including
one owned by another account. The launcher file is
written to a temporary file and renamed into place; an existing symbolic link at
that path is replaced, not followed.

`restore` applies the same ownership, permissions, and signature checks to the
bundle and its main app executable before quitting or opening it. It works with
the experimental flag off and without a bundled app-server binary. If trust
verification or relaunch fails, the existing launcher is kept for recovery.

Both commands also check the folders containing the bundle up to the filesystem
root. Folders owned by another account, symbolic links, and ordinary group- or
world-writable parents are refused. Root-owned administrator-group installation
folders and trusted sticky folders retain their normal permissions behavior.
These are ownership, POSIX-permission, and signature checks; native ACL and
volume ownership-policy behavior has not been verified.

This integration installs no certificate, network listener, PAC, or background
watcher. It does not log the app's messages or environment. Status reports whether
the running ChatGPT bundle process carries the expected launcher override.

If app discovery or process inspection fails, `status` reports `unknown` rather
than `not running`. `launch` and `restore` refuse to reopen an app whose exit
cannot be confirmed; restore keeps the launcher. Resolve the inspection error
and retry. Launch checks before writing its launcher, but a later inspection can
still fail after that atomic update; the commands do not guarantee an all-or-nothing
restart transaction.

## Failure behavior and known limits

When the platform is not macOS, the OpenCodex runtime is missing, or the filter
self-test fails, the launcher runs the original binary with untouched stdout. A
missing bundled app-server binary is the exception: there is nothing to fall back
to, so the launcher exits with an error (see below).
A filter that passes the self-test and then dies mid-session closes the pipe.
What the bundled app-server does after that has not been verified; it may get
SIGPIPE or a write error and be respawned by Desktop through the same launcher.
The filter's passthrough mode limits this to an exit/crash case: a rewrite exception
passes its line through, and an unexpected rewrite-machinery failure switches the
remaining stream to raw bytes.

The experiment depends on the bundled binary path, the app honoring
`CODEX_CLI_PATH`, and current RPC field shapes. Updates may change these. A moved
or removed OpenCodex installation fails the launcher preflight and runs the
original binary. Run `ocx chatgpt launch` again after relocating the installation.
If an app update moves or removes the bundled app-server binary itself, the
launcher cannot start it: it prints a message naming `ocx chatgpt launch` and
`ocx chatgpt restore` on stderr and exits, and Desktop cannot start its
app-server until you run one of them. A single output line longer than 8 MiB is
passed through unparsed rather than buffered.

This standalone shim does not rewrite conversation metadata or route model calls.
Other app gates or upstream refusals can still prevent sending. An attached launcher
or a passing filter self-test does not prove that the app's gate data crosses this pipe.

Reporter observations in [#6196](https://github.com/lidge-jun/opencodex/issues/6196)
on October 2 and 13, 2026 describe an attached shim with Send still disabled at
natural quota exhaustion. On Desktop 26.1007.30912 with OpenCodex 2.84.0, the
reporter observed no eligible rate-limit RPC messages while the renderer's gate
used a separate usage transport. This shim cannot rewrite data that never reaches
its stdout filter. These are build-specific field reports, not a new live
verification or proof that every Desktop build uses the same transport.

The remaining signed-in composer behavior stays tracked in #6196. Earlier success
with a combined shim/intercept configuration does not establish shim-only
sufficiency, and the closed, unmerged #6365 intercept is not a shipped remedy.
