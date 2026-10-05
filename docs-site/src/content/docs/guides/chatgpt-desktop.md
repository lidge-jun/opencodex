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

Launch restarts ChatGPT with
`--host-resolver-rules=MAP chatgpt.com 127.0.0.1:<port>`. Explicit system HTTP/SOCKS
proxies get an apex-host bypass while other hosts retain the proxy with a direct
fallback; TUN/direct networking needs only the resolver rule. An existing system
PAC cannot be combined with that bypass, so it may prevent the intercept from
seeing traffic. This candidate creates no PAC file or CONNECT entry proxy.

If both flags are true, `ocx chatgpt launch` applies the existing app-server shim
and the intercept together. The shim alone still works without a running proxy.
The intercept requires OpenCodex's identity-confirmed listener. When OpenCodex
stops, an app still carrying the resolver rule cannot reach `chatgpt.com`; run
`ocx chatgpt restore` to relaunch with native networking.

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

### Evidence and decision limits

[#6196](https://github.com/lidge-jun/opencodex/issues/6196) reported zero established
listener connections over about 20 hours on current Desktop builds: the bundled
app-server performs the gate reads and may bypass Chromium's resolver rule.
The later exhausted-Plus-account report used the shim, intercept and restart
together and does not isolate the intercept's effectiveness. This candidate
conflicts with the maintainer's provider-aware admission design, which rejects
local CA installation and quota-data rewriting; maintainers may close it.
