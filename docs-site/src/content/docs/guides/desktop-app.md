---
title: Desktop App
description: Install and use the OpenCodex desktop app on macOS, Windows, and Linux.
---

The OpenCodex desktop app combines a native tray with the web dashboard. It discovers an
existing local proxy, or starts the bundled `ocx` sidecar when no proxy is running.

The dashboard remains available at [http://127.0.0.1:10100](http://127.0.0.1:10100).
The desktop app does not replace the proxy; it is a local shell around the dashboard and
its bundled runtime.

## Install

### macOS

Download `OpenCodex-<version>-macos.dmg` from the
[latest release](https://github.com/lidge-jun/opencodex/releases). Open the DMG and drag
`OpenCodex.app` to Applications.

On first launch, macOS Gatekeeper may warn that the developer cannot be verified. Right-click
the app, choose **Open**, and confirm **Open**. This build is signed for integrity but is not
yet notarized.

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

The app first looks for an existing `ocx` proxy on loopback, using the runtime port
metadata when available and falling back to port `10100`. If no proxy answers, it starts
the bundled sidecar. The dashboard is then opened inside the app's webview.

Use the tray's **Open dashboard** or **Open in browser** action to move between the
embedded dashboard and your normal browser. The tray also provides update checks.

## Updates

Choose **Check for Updates…** in the tray menu to check immediately. Release builds also
check automatically after startup and every six hours. Updates are verified with the
project's signed updater public key before installation. On macOS, in-app updates download
`OpenCodex-<version>-macos.app.tar.gz`; the DMG is for the first installation.
The release manifest is generated only when the updater key secret is configured and then
requires all four platforms to be signed.

## Widget

The macOS app includes the OpenCodex WidgetKit extension. See the
[macOS Menu Bar App guide](/opencodex/guides/macos-menu-bar/) for widget setup and the
privacy-safe snapshot details.

## Uninstall

On macOS, drag `OpenCodex.app` from Applications to the Trash. On Windows, remove
OpenCodex from **Installed apps**. On Debian-based Linux systems, run:

```bash
sudo apt remove opencodex
```

For an AppImage, delete the downloaded file.
