---
title: macOS Menu Bar
description: Build and use the native opencodex menu bar companion for proxy status and lifecycle control.
---

The macOS 12+ companion keeps opencodex controls in the system menu bar. It shows proxy health,
version, uptime, PID, port, Bun runtime source, and launchd state, then provides the common actions
without a terminal.

## Build and open

Install and initialize the `ocx` CLI first, then build the app from the repository:

```bash
bun run build:macos-app
open "dist/macos/OpenCodex.app"
```

The default build targets the current Mac. With the full Xcode toolchain selected, set `UNIVERSAL=1`
to build arm64 and x86_64 together (Command Line Tools alone only supports the current architecture):

```bash
UNIVERSAL=1 bun run build:macos-app
```

The output is ad-hoc signed for local use. A warning-free public distribution still requires the
maintainer's Developer ID signing and notarization flow.

## Release packaging

The Release workflow builds both arm64 and x86_64, packages `OpenCodex.app` as
`OpenCodex-<version>-macos-universal.zip`, and generates a matching `.sha256` file. Dry runs build,
transfer, and verify both files as workflow artifacts. Non-dry-run releases attach them to the
GitHub Release after npm publishing succeeds.

The automated archive is ad-hoc signed and not notarized, so macOS may require manual approval on
first launch. If Gatekeeper blocks it, Control-click `OpenCodex.app` and choose **Open**, or go to
**System Settings → Privacy & Security** and click **Open Anyway**.

## Menu actions

| Item | Behavior |
| --- | --- |
| **Proxy status** | Stays visually prominent; open its submenu for version, PID, port, uptime, runtime, service, and CLI details. |
| **Open Dashboard** | Opens the live dashboard URL reported by `ocx status --json`. |
| **Start Proxy** | Starts the installed launchd service, or launches a standalone proxy when no service is installed. |
| **Restart Proxy** | Confirms first, then uses a service-aware stop/start sequence. |
| **Stop Proxy** | Confirms first, gracefully drains and stops the proxy, stops its service, and restores native Codex. |
| **Refresh Status** | Re-reads the CLI status contract immediately; the app also refreshes periodically and whenever the menu opens. |
| **Quit Menu Bar App** | Quits only the companion. The proxy keeps its existing state. |

Restart and stop can interrupt active requests, so both actions use a confirmation dialog.

## Finding `ocx`

The app checks the inherited `PATH`, Homebrew, Bun, Volta, pnpm, `~/.local/bin`, nvm, and fnm
locations. If a version manager hides the executable from GUI apps, choose **ocx CLI…** and select
the executable manually. **Use Auto-detected CLI** removes that override.

The companion also inherits `CODEX_HOME` and `OPENCODEX_HOME` from the installed launchd plist so a
service installed with custom state paths is controlled consistently. It does not read or display
API keys, OAuth credentials, request bodies, or account identities.

To open the companion automatically, add the built app under **System Settings → General → Login
Items**. This is separate from `ocx service install`: the login item starts the menu UI, while the
service keeps the proxy alive and restarts it after crashes.
