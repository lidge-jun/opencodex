---
title: ChatGPT Desktop app-server shim (experimental)
description: An opt-in macOS experiment that rewrites plain-quota gate fields on the bundled app-server stdout pipe.
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

This integration installs no certificate, network listener, PAC, or background
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
