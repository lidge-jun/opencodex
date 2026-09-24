---
title: Desktop App
description: Install and use the OpenCodex desktop app on macOS, Windows, and Linux.
---

The OpenCodex desktop app combines a native tray with the web dashboard. Its bundled CLI
resolves an existing local proxy; the app starts its bundled runtime only when absence is proven.

The dashboard is served from the resolved local proxy endpoint (port `10100` by default).
The desktop app is a local shell around that dashboard and its bundled runtime.

## Install

### macOS

Download `OpenCodex-<version>-macos.dmg` from the
[latest release](https://github.com/lidge-jun/opencodex/releases). Open the DMG and drag
`OpenCodex.app` to Applications. The app requires macOS 13 or later.

Release builds of `OpenCodex.app` are signed with a Developer ID and notarized by Apple, so on
first launch macOS normally asks only for the standard confirmation for a downloaded app. If macOS
still blocks it, use **System Settings → Privacy & Security → Open Anyway**.

### Windows

Download `OpenCodex-<version>-windows-x64.msi` and run the installer. Windows SmartScreen may
warn because the installer is not yet code-signed; choose **More info → Run anyway** after
confirming that you downloaded it from the release page.

### Linux

Download `OpenCodex-<version>-linux-x86_64.AppImage` or
`OpenCodex-<version>-linux-amd64.deb` from the release page.

For the AppImage:

```bash
chmod +x OpenCodex-<version>-linux-x86_64.AppImage
./OpenCodex-<version>-linux-x86_64.AppImage
```

For Debian-based distributions:

```bash
sudo apt install ./OpenCodex-<version>-linux-amd64.deb
```

The tray icon requires an AppIndicator-capable desktop environment.

## First launch

The app asks its bundled CLI to run `ocx resolve --json` and attaches to a reachable local
proxy if one is already running. It starts the bundled runtime only when the CLI proves
absence; an uncertain result is shown as a startup failure. The dashboard then opens in
the app's webview at the resolved loopback endpoint. A login launch that starts hidden in the
tray keeps the lightweight startup page instead, and loads the dashboard the first time you open
it from the tray or launch the app again.

Use the tray's **Open dashboard** or **Open in browser** action to move between the
embedded dashboard and your normal browser. The tray also provides update checks.

On macOS, closing the dashboard keeps the app running in the menu bar. Open OpenCodex again from Dock or Finder to restore the dashboard without restarting the proxy.

## Usage in the tray

On macOS and Windows, click the tray icon to open a compact usage window. The tray's
**Show usage** action also opens it, including on Linux desktops whose tray does not
forward click events. On Linux the dashboard opens at startup, including when the
desktop environment does not expose a tray icon.

The usage window shows Today and 30-day totals, the configured usage chart, a compact
model list, and provider/account limits. Quota reset countdowns sit beside their bars;
hover for the exact reset time. Existing **Menu bar & widget** settings control the
visible sections and chart. Hidden providers are excluded from the title, totals, quotas and chart.
The chart includes activity from the current time interval. A partial-data indicator means some
chart data cannot be attributed reliably. Missing measurements are not presented as zero usage.
On Windows and Linux, scroll within the usage window to reach Refresh and Dashboard at the
end of a long account list.

On macOS, this window uses native SwiftUI controls and a scrollable AppKit panel. Apple
Liquid Glass is used on macOS 26 and later; older systems use the native popover material.
The header and the Refresh and Dashboard buttons remain visible while scrolling long
account lists. You can also open it with **View → Show Usage** (Command-Shift-U).
Press Escape or click outside the panel to dismiss it.

The tray menu shows today's request count and tokens, with estimated cost when enabled.
It uses the same local-day usage as the widget. Choose **Refresh now** to update immediately;
the app also refreshes every 60 seconds. Display preferences remain in the dashboard's
**Menu bar & widget** section. Turning off **Today** hides the summary, and turning off
**Cost** removes the cost from it.

Unavailable or explicitly unmeasured usage is shown as `—`, not as a measured zero.
Choosing the icon-only headline clears the previous counter. Abbreviations preserve
whole-number zeros: ten million tokens is `10M`, not `1M`.

## Updates

Choose **Check for Updates…** in the tray menu to check immediately. Release builds also
check automatically after startup and every six hours.

When the Tauri updater finds a newer app version, a blue dot appears on the macOS menu-bar icon or the Windows/Linux tray icon where a tray host is available. The embedded dashboard shows the same desktop update signal. A normal browser connected to the same proxy still shows the proxy package update state. If the shell stops reporting for about three minutes, the embedded badge becomes unknown until it reconnects. The dot reports availability; installation remains an explicit action.

In the desktop app, choose the dashboard's update button to open the app's update page.
There you can check again, install a pending signed update, or return to the dashboard.
The same install action is available from the tray menu. If installation fails, the
pending update remains available for retry. This page also works on Linux when the
desktop has no tray icon. A normal browser dashboard manages the package installation
on that proxy instead.

Updates are verified with the
project's signed updater public key before installation. On macOS, in-app updates download
`OpenCodex-<version>-macos.app.tar.gz`; the DMG is for the first installation.
The release manifest is generated only when the updater key secret is configured and then
requires all four platforms to be signed.

## Widget

The macOS app includes the OpenCodex WidgetKit extension. See the
[macOS Menu Bar App guide](/guides/macos-menu-bar/) for widget setup and the
local snapshot details.

## Uninstall

On macOS, drag `OpenCodex.app` from Applications to the Trash. On Windows, remove
OpenCodex from **Installed apps**. On Debian-based Linux systems, run:

```bash
sudo apt remove opencodex
```

For an AppImage, delete the downloaded file.

If saved menu-bar settings cannot be read, partial edits are refused to preserve the file. Restore the file or explicitly reset the companion settings before editing again.
