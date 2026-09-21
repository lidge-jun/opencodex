---
title: macOS Menu Bar App
description: A native menu bar companion that shows OpenCodex proxy status, usage, and provider quotas at a glance.
---

The macOS companion puts OpenCodex in your menu bar: proxy health, recent usage, and
per-provider quota pressure, without opening the dashboard.

It is a separate application from the proxy. `ocx` keeps running as it always has; the
companion is a read-mostly client that talks to the local management API.

## Desktop app (Tauri)

The same dashboard can run inside the OpenCodex desktop app. The Usage companion panel
uses the OS selector to show the matching macOS, Windows, or Linux installation steps.
While the dashboard is inside the desktop shell, choose **Open in browser** to open the
current dashboard view in your normal browser.

## Install

Install the desktop app from the
[latest release](https://github.com/lidge-jun/opencodex/releases). On macOS, download
`OpenCodex-<version>-macos.dmg`, open it, and drag `OpenCodex.app` to Applications.
Windows users can run `OpenCodex-<version>-windows-x64.msi`; Linux users can use the
AppImage or `OpenCodex-<version>-linux-amd64.deb`.

```bash
chmod +x OpenCodex-<version>-linux-x86_64.AppImage
sudo apt install ./OpenCodex-<version>-linux-amd64.deb
```

## First launch: Gatekeeper

**The first launch will be blocked.** macOS will say:

> "OpenCodex.app" cannot be opened because the developer cannot be verified.

This is expected, and it is worth explaining rather than talking you past it. Gatekeeper
wants a Developer ID signature and a notarization ticket from Apple, both of which
require a paid Apple Developer account. OpenCodex does not have one, so the app ships
ad-hoc signed: the bundle is intact and its signature is valid, but Apple has not
vouched for the publisher.

To open it anyway:

1. Right-click (or Control-click) `OpenCodex.app` in Finder.
2. Choose **Open**.
3. Click **Open** in the dialog that appears.

If that dialog does not offer an Open button, go to **System Settings → Privacy &
Security**, find the blocked-app notice, and click **Open Anyway**.

macOS remembers the decision, so this is a one-time step per version.

Alternatively, remove the quarantine attribute from the terminal:

```bash
xattr -d com.apple.quarantine /Applications/OpenCodex.app
```

If you would rather not do either, build from source — a local build carries no
quarantine attribute at all. See [Build from source](#build-from-source).

## What it shows

The menu bar icon reflects proxy state without using colour, since macOS menu bar items
are monochrome by convention:

| Icon | Meaning |
| --- | --- |
| Solid mark | Running and protected |
| Solid mark with a notch | Running, but routing protection is at risk |
| Outlined mark | Starting up, or degraded |
| Faded outline | Not running, or needs an API key |

Clicking it opens a panel with four sections:

**Status** — whether the proxy is running, the loopback endpoint the app is using, and
the protection state. When the proxy recommends a remediation command (for example
`ocx service install`), it appears here as selectable text. The app never runs it for
you.

**Usage** — requests, tokens, and estimated cost over the last 7 days, with a daily
trend. A `~` after the request count means part of it is estimated rather than reported
by the provider.

By default, the menu bar headline shows total tokens; change the headline metric in the
dashboard Usage companion settings when you prefer requests, cost, quota, or an icon only.
On macOS 26, the popover and widgets adopt Liquid Glass; earlier macOS versions use the
standard popover material.

**Quotas** — one row per provider, showing the window under the most pressure. A
provider at 99% of a five-hour limit and 10% of its monthly limit shows the five-hour
figure, because that is the one currently blocking you. The window name is printed under
the provider so `42% of API usage` and `42% of a month` are never confused.

**Providers** — a collapsible list with a switch per provider. The default provider's
switch is inert while it is enabled, because the proxy refuses to disable it; choose a
different default in the dashboard first.

## What it can do

- **Dashboard** opens the web dashboard in your browser.
- **Stop proxy** stops the proxy, after confirming. This is deliberately not called
  "Restart": stopping also stops the launchd service, so nothing brings the proxy back
  automatically. The panel then shows the command to start it again.
- **Provider switches** enable or disable a provider.

Everything else — accounts, model configuration, storage — stays in the dashboard.

## Widget

Add the widget from the desktop: right-click, choose **Edit Widgets**, then add
**OpenCodex**. It shows proxy status, today's usage, quota pressure, and the same
privacy-safe usage snapshot as the desktop app. The widget refreshes when the app polls.
It requires macOS 14 or later and reads only the privacy-safe snapshot written by the
OpenCodex app; it does not receive API keys or raw account data.

## Connecting to the proxy

The app finds the proxy automatically. It reads `~/.opencodex/runtime-port.json` (or
`$OPENCODEX_HOME/runtime-port.json`) and falls back to port `10100`. Only the port is
taken from that file; the host is always loopback.

If your proxy is bound to a non-loopback address it will require an API key. The panel
says so and offers a link to the dashboard.

**This case is not supported yet.** The app reads a key from the macOS Keychain and
retries once with it, but there is no UI for entering one and no supported way to
provision it by hand — the item is a data-protection Keychain entry, which Keychain
Access does not create. So on a non-loopback bind the panel stays on "Needs API key".

A loopback proxy — the default — needs no key at all. Native key entry is planned.

## Polling

The app is deliberately quiet. It checks whether the proxy is alive every 5 seconds, and
fetches the expensive aggregate data — usage and quotas — only while the panel is open,
at most once a minute. After three consecutive failures it backs off to every 30 seconds
rather than hammering a proxy you stopped on purpose.

## Build from source

Requires macOS 13 or later, the Xcode Command Line Tools, and [Bun](https://bun.sh):

```bash
git clone https://github.com/lidge-jun/opencodex.git
cd opencodex
bun run prepare-sidecar
bun run prepare-widget
bunx tauri build
```

The bundle appears in Tauri's release output, with the WidgetKit appex under
`OpenCodex.app/Contents/PlugIns/`.

Building a universal binary (`UNIVERSAL=1`) needs the full Xcode toolchain — Command
Line Tools ships only current-architecture Swift compatibility libraries, and the build
will tell you so rather than failing with a linker error.

If you have a Developer ID certificate in your keychain, set `MACOS_SIGN_IDENTITY` to
sign with the hardened runtime instead of ad-hoc:

```bash
MACOS_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" bun run prepare-widget
```

## Uninstall

Drag `OpenCodex.app` to the Trash. The app writes no preferences or state of its own, and
stores nothing in the Keychain today.
