---
title: Platform support
description: What OpenCodex can do on macOS, Windows and Linux, and why a few capabilities stay platform-specific.
---

OpenCodex runs on macOS, Windows and Linux. Most of it behaves identically on all
three; a few capabilities depend on something the operating system provides, and
this page says which, and why.

## Everywhere

| Capability | Notes |
| --- | --- |
| Proxy, routing, provider adapters | The core runtime is platform-neutral. |
| Background service | Three native backends: launchd on macOS, Task Scheduler **or** WinSW on Windows, a systemd user unit on Linux. |
| Browser login | Opens through the platform's own handler. |
| Client detection | Cursor, Claude Desktop, Kiro and Codex installs are located per platform. |

### Provider keys in the OS credential store

Supported on all three platforms, **when an unlocked OS credential service is
available**: Keychain on macOS, Credential Manager on Windows, libsecret on
Linux. A locked keyring or a headless session has no unlocked service, so the
store is unavailable and OpenCodex says so rather than silently falling back.
See [Providers](/reference/configuration/providers/) for the storage rules.

## macOS only

### Claude Code auto-connect

Injecting `ANTHROPIC_BASE_URL` and the Claude Code levers into your session
happens through the launchd user domain, which has no single equivalent
elsewhere.

On Linux the three plausible mechanisms each reach a different set of processes:
`systemctl --user set-environment` reaches only systemd-spawned units,
`~/.profile` only login shells, and `~/.bashrc` only interactive non-login
shells. There is no one place that covers a user's whole session.

On Windows the equivalent is `HKCU\Environment`, which is genuinely persistent
rather than per-boot. That is the problem: it would move a bearer token from a
domain that empties at reboot into a registry hive that does not, which is a
change in how long the credential sits on disk and who can read it. That
decision needs a security review rather than a port.

Everything else Claude Code needs works on all platforms. You can set the same
variables yourself, or run `ocx claude`, which passes them to the child process
directly.

## Import versus paste

### Meta Muse Code

On macOS, a plain login first tries the API key already stored by `muse login`.
If none is available, or on another platform, OpenCodex starts device approval
without launching the Muse CLI. Add-account and reauthentication skip import.
A failed, uncancelled device login can fall back to a manual key when the caller
offers an input surface. Pasted keys use the same format and Model API validation
as imported ones. Management login requires a dashboard session before either
credential-acquisition path; see the [provider guide](/guides/providers/).

For Responses requests to Meta, omitted or `auto` tool selection is supported.
Explicit `none` sends `tools: []` and removes `additional_tools` items from the
input. Forced, named, and `allowed_tools` selections return HTTP 400 before the
request reaches Meta because Muse accepts only `auto`. Other Responses
destinations keep their existing tool-selection behavior.

## Windows notes

The Windows service can run under Task Scheduler or as a native WinSW service,
and those are mutually exclusive. `ocx service repair` refuses to proceed when
it finds state for both, because guessing which one you meant is how a machine
ends up with two proxies fighting over a port.

Console output on a non-English Windows install arrives in the system code page
rather than UTF-8. OpenCodex decodes it accordingly, so an account name with
non-ASCII characters resolves correctly.

## When something is unavailable

OpenCodex states the actual reason rather than disabling a control silently. If
a capability is unavailable on your platform, the error or the dashboard says
which mechanism is missing and what the supported alternative is. If you hit one
that does not, that is a bug worth reporting.
