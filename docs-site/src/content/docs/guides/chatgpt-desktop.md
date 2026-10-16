---
title: ChatGPT Desktop integrations (experimental)
description: Opt-in macOS app-server shim and local-CA TLS intercept experiments for plain-quota send gates.
---

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

The app-server shim alone installs no certificate, network listener, PAC, or background
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
Other app gates or upstream refusals can still prevent sending. Evidence reported
on an exhausted Plus account also used an intercept, so it does not establish
that this shim alone resolves every desktop send lock.

## Local-CA TLS intercept (experimental candidate)

The separate `chatgptDesktop.unblockSend` experiment terminates TLS for the
`chatgpt.com` apex host on loopback, relays the account's cookies and credentials,
and rewrites known quota send gates in conversation metadata and usage responses.
It is **off by default**, macOS only, and independent of `appServerShim`:

```json
{
  "chatgptDesktop": {
    "unblockSend": true,
    "port": 10300
  }
}
```

`port` is optional; its default is the running proxy's public port plus 200
(`10100` → `10300`). A derived port outside the TCP range requires an explicit
free port. Client-role processes do not start the intercept. A bind or certificate
failure warns without stopping the proxy's other services.

Start OpenCodex with this config, then run `ocx chatgpt status`. The listener
creates or reuses the local authority shared with the Claude intercept. **You
must trust this CA yourself** in the macOS login keychain before launching the
intercepted app. Status prints the exact command; with the default config path:

```bash
security add-trusted-cert -r trustRoot -p ssl -k "$HOME/Library/Keychains/login.keychain-db" "$HOME/.opencodex/claude-intercept/ca.pem"
ocx chatgpt launch
ocx chatgpt status
```

Use the certificate path reported by status if your OpenCodex home differs. The
CLI prints the trust command and never runs it. Trusting a local CA changes the
login keychain's TLS trust: anyone controlling its private key can issue trusted
certificates. The listener sees the decrypted account traffic, including cookies,
authorization headers and message content that it relays. Protect the config
directory and CA key. The relay does not log request bodies or credentials.
`restore` removes launch overrides; it does **not** remove CA trust or delete the
shared authority. Remove trust manually through Keychain Access when you no
longer need it, accounting for other integrations using the same authority.

Status checks the current CA's validity, exact presence in the login keychain, and
usable user-domain SSL trust settings. An explicit deny or unrelated/scoped policy
does not count as trust; malformed or ambiguous settings report `unknown`. This
is a configuration check, not proof that a particular app build accepts the
intercepted certificate or routes all its traffic through Chromium.

Launch restarts ChatGPT with
`--host-resolver-rules=MAP chatgpt.com 127.0.0.1:<port>`. Explicit system HTTP/SOCKS
proxies get an apex-host bypass while other hosts retain the proxy without a synthetic
direct fallback; TUN/direct networking needs only the resolver rule. An existing system
PAC cannot be combined with that bypass, so it may prevent the intercept from
seeing traffic. With `pacFallback` (below) the app is launched through a generated
PAC instead of the resolver rule.

If both flags are true, `ocx chatgpt launch` applies the existing app-server shim
and the intercept together. The shim alone still works without a running proxy.
The intercept requires a listener authenticated by the published local CA and the `chatgpt.com` hostname,
then confirmed by its service identity. Missing or invalid CA files leave the app untouched; these
checks do not install keychain trust. When OpenCodex
stops, an app still carrying the resolver rule cannot reach `chatgpt.com`; run
`ocx chatgpt restore` to relaunch with native networking, or use PAC fallback.

### PAC fallback: preserve your network policy when OpenCodex stops

PAC fallback launches the app with a generated PAC script instead of the resolver
rule, so the app falls back on its own. The script is passed inline (a `data:` URL)
because the app ignores a `file://` PAC and an `http://` one would need OpenCodex
running to be fetched:

```json
{ "chatgptDesktop": { "unblockSend": true, "pacFallback": true } }
```

`pacFallback` only takes effect together with `unblockSend`. Config diagnostics
warn when PAC fallback is enabled on its own; the saved flags are left unchanged.
OpenCodex normally also listens on the listener port plus one (`10301` by default),
or port `65534` when the listener uses `65535`. This CONNECT entry splices onto the
TLS listener. OpenCodex rewrites `chatgpt-unblock.pac` in its home
directory at every start, before the `chatgpt-unblock.ready` marker. Before restarting an
app, the launcher prepares the PAC argument; if the file cannot be read and encoded,
is empty, or is not a regular file, it leaves the running app untouched. The PAC sends
`chatgpt.com` to that entry first, and every other host the way the system routes it:

The listener does not report ready or forward traffic until this startup completes.
Stopping it rejects new requests and closes active policy-routed HTTP streams, CONNECT and WebSocket relays.
Stale PAC/readiness files alone never authorize a watcher restart.

| Setup | Other hosts, and `chatgpt.com` while OpenCodex is stopped |
|---|---|
| No proxy, or VPN in TUN mode | Direct. |
| VPN in system-proxy mode | The configured system proxy chain, without adding direct fallback. |
| PAC file | The system PAC, embedded in the generated file. |

The generated PAC is intended to let the app use the captured route without a
restart when OpenCodex stops; the send unblock pauses until OpenCodex is back.
Loopback tests verify socket cleanup, process-crash port release and restart, but
actual macOS app cached-PAC recovery still needs acceptance testing.
If every configured proxy is unavailable,
requests fail instead of silently connecting directly. Embedded system PACs retain
Chromium’s non-mandatory PAC behavior: invalid results or execution failures can
still fall back directly. Do not use that mode when a fail-closed system-PAC policy is required. The route is captured when
OpenCodex starts: after changing the VPN mode, restart OpenCodex and run
`ocx chatgpt launch`. PAC downloads must finish within 3 seconds; downloads and local file
reads are capped at 4 MiB. If a system PAC is set but cannot be read at that moment, or
is too large to pass to the app (the PAC travels inside one launch argument,
limited to 512 KiB once encoded), the optional intercept does not start. An unreadable
system proxy configuration or automatic proxy discovery also prevents PAC-mode startup; fix it and restart OpenCodex. After turning `pacFallback` on
or off, restart OpenCodex, run `ocx chatgpt launch`, and run
`ocx chatgpt install-watcher` again if you use the watcher. `restore` undoes a PAC
launch the same way as a resolver-rule one. Resolver-rule launches likewise reject unreadable
system proxy settings before quitting the app and never add a direct fallback to an explicit
proxy. `restore` remains available even when proxy settings cannot be read.

### Existing proxy policy while the intercept is running

For both resolver and PAC launch modes, OpenCodex now reads the system proxy configuration once
at startup. A configured system PAC is evaluated inside an isolated, runtime-owned JavaScript
worker for both HTTP and WebSocket upstream requests. A static system proxy chain is also kept
strict. No separate background service is installed. If neither system policy exists, the existing
OpenCodex outbound proxy selection remains in use.

Only an explicit `DIRECT` PAC result permits direct upstream access. Supported proxy results are
`PROXY`, `HTTPS` and `SOCKS5`; malformed or unsupported results fail the request. Failover to the
next listed route is limited to failure before establishing its TCP connection. Proxy refusal,
TLS/certificate errors and responses do not retry or replay a chat POST. Upstream TLS verification
remains enabled.

The evaluator deliberately supports a restricted PAC subset. Classic domain matching, `*`/`?`
globs, weekday ranges and IPv4 DNS helpers are supported. `myIpAddress`, date/time ranges, IPv6
extension helpers, extended glob syntax, dynamic/async code, and `catch`/`finally` recovery syntax
are unsupported. Keywords appearing only in comments or strings are allowed. Exception recovery
is excluded because the engine cannot reliably report a caught allocation failure. DNS lookup
errors also stop routing, including ambiguous negative answers, instead of permitting a rule to
mistake an error for a direct route.

These restrictions can reject a PAC that works in your browser. The worker has bounded memory,
execution time, DNS work and request queue size. An unsupported operation, invalid route, runtime
error, cancellation or exceeded limit closes that policy until OpenCodex restarts; it never switches
to an environment proxy or an implicit direct route. HTTPS and secure WebSocket PAC matching uses
the scheme and host, with path, query and credentials removed.

This protection applies while traffic passes through the active OpenCodex listener. The browser's
embedded PAC after OpenCodex exits still has the non-mandatory behavior described above; native
app certificate acceptance and cached-PAC stop/crash recovery require separate macOS acceptance.

### Intercept rewrite boundary

Only `/backend-api/conversation/init`, `/backend-api/conversation` and
`/backend-api/f/conversation` (including child paths), plus the exact
`/backend-api/wham/usage` and `/backend-api/wham/usage/stream` paths are rewritten.
Conversation metadata loses known quota `send` / `tpp_send` blocks and exhausted
send progress entries. Unknown and subscription/policy/workspace reasons remain;
status reports preserved reasons. Usage rewriting reuses the shim's gate helpers,
keeping workspace, credit and spend-control gates and usage display intact. Other
HTTP responses pass through; WebSocket upgrades, voice and dictation relay
without rewriting through direct, HTTP CONNECT or shared SOCKS5 transport.

### Optional intercept launch watcher

```bash
ocx chatgpt install-watcher --yes
ocx chatgpt uninstall-watcher
ocx chatgpt restore
```

Installation without `--yes` asks in an interactive terminal. The launchd agent
watches the app's Electron `SingletonLock` and the `chatgpt-unblock.ready` marker. In watch
mode, it restarts an app launched without intercept switches only while the listener answers as
OpenCodex and the app is no more than five minutes old; a missing or unparseable process age
counts as fresh, and explicit `ocx chatgpt launch` is not age-limited. This can interrupt
startup work; it does nothing while the listener is unavailable. It manages
**intercept launches only**; use explicit launch for the app-server shim. A loaded
watcher must be uninstalled before `restore`, so it cannot put the switches back.
The watcher records the absolute bundle path discovered at installation. Before each restart,
it rechecks the bundle identifier, ownership, parent permissions and OpenAI signature, then quits
and opens that same path. If the bundle or OpenCodex runtime moved, reinstall the watcher; a failed
check leaves the running app untouched.
In PAC-fallback mode the watcher also verifies a complete CONNECT and CA-authenticated identity
exchange through the entry, and launches with the PAC switch instead of the resolver rule. A foreign
listener or an entry that only accepts TCP is not considered ready.

### Evidence and decision limits

[#6196](https://github.com/lidge-jun/opencodex/issues/6196) reported zero established
listener connections over about 20 hours on current Desktop builds: the bundled
app-server performs the gate reads and may bypass Chromium's resolver rule.
The later exhausted-Plus-account report used the shim, intercept and restart
together and does not isolate the intercept's effectiveness. This candidate
conflicts with the maintainer's provider-aware admission design, which rejects
local CA installation and quota-data rewriting; maintainers may close it.
