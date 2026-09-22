---
title: macOS Menu Bar App
description: Use the OpenCodex desktop app's macOS tray, native usage panel, and widget.
---

The macOS menu bar item is part of the OpenCodex desktop app. It shows usage from the local proxy and opens a native usage panel. The same app also contains the dashboard and a WidgetKit extension. See the [desktop app guide](/guides/desktop-app/) for installation on other platforms.

## Install

Download `OpenCodex-<version>-macos.dmg` from the [latest release](https://github.com/lidge-jun/opencodex/releases). Open the DMG and drag `OpenCodex.app` to Applications. The desktop app requires macOS 13 or later; its widget requires macOS 14 or later.

## First launch

Release builds of `OpenCodex.app` are signed with a Developer ID, use the hardened runtime, and are notarized by Apple with the ticket stapled to the app. On first launch, macOS normally asks only for the standard confirmation for an app downloaded from the internet. If macOS still blocks it, open **System Settings → Privacy & Security** and choose **Open Anyway** for OpenCodex. Apps you build yourself are ad-hoc signed; see [Build from source](#build-from-source).

The app shows its startup progress in a window when you open it. It enables **Start at Login** once on first launch; you can turn that off from the tray menu. Later launches from the login item start with the window hidden while the tray remains available.

## Menu bar and usage panel

The menu bar headline shows today's total tokens by default. In the dashboard's **Menu bar & widget** settings, you can choose requests, tokens, estimated cost, quota, or icon only.

Use **Show Usage** in the tray menu to open the native panel. The panel shows today's and 30-day totals, a usage chart, a model list, and provider and account limits according to your display settings. Totals include tokens and requests, with estimated cost when enabled. Quota rows show their window, percentage, and reset time. Missing measurements appear as `—`, and partial usage is marked as incomplete.

The panel has **Refresh**, **Dashboard**, and **Settings** controls. **Dashboard** opens the usage view in the desktop window; **Settings** opens the companion settings there. The tray menu also offers **Open Dashboard**, **Open in Browser**, **Start at Login**, **Stop proxy**, **Check for Updates…**, an **Install update** item when one is available, and **Quit**. **Stop proxy** is always listed but is enabled only when the app started the proxy itself; a proxy you started separately keeps running. Closing the window or using Command-Q hides the app when its tray is available; use the tray's **Quit** to exit it.

The tray headline refreshes every 60 seconds. While the native panel is open, its data refreshes every 60 seconds; **Refresh** requests an immediate update.

## Widget

On macOS 14 or later, open OpenCodex.app once, then Control-click an empty area of the desktop, choose **Edit Widgets**, search for **OpenCodex**, and add the size you want. Widget sizes show different combinations of proxy status, today's tokens and requests, estimated cost, quotas, and a usage chart. The extension reads a local snapshot written by the desktop app; that snapshot contains display data, not API keys or raw account data. The app refreshes the widget snapshot on every fifth 60-second tray tick, about every five minutes while the proxy is connected. WidgetKit also requests a new timeline after five minutes.

## Connecting to the proxy

The desktop app asks its bundled CLI to run `ocx resolve --json`. It attaches to an existing reachable local proxy, or starts its bundled runtime only when the CLI proves no runtime is listening. If discovery is uncertain, startup reports the problem instead of starting a second proxy. The app talks to the resolved port on `127.0.0.1`.

For management requests, the app first tries without a token. If the proxy returns HTTP 401, it retries using `OPENCODEX_ADMIN_AUTH_TOKEN` from the app's environment or the resolved configuration home's `admin-api-token` file. It does not use the macOS Keychain for this token. A proxy bound only to an address the app cannot reach on loopback cannot be attached to by the desktop shell.

## Build from source

On macOS 13 or later, with Bun, Rust, and the macOS Swift/Xcode tools available, build the dashboard from the repository root, then run the desktop commands from `desktop/`:

```bash
bun install
bun run build:gui
cd desktop
bun install
bun run prepare-sidecar
bun run prepare-widget
bun run build:local
```

`build:local` produces the local app and DMG without requiring a Tauri updater signing key. A direct `bunx tauri build` requires `TAURI_SIGNING_PRIVATE_KEY` because it also produces an updater artifact. The widget build uses an ad-hoc signature unless `MACOS_SIGN_IDENTITY` is set, and local desktop bundles are also ad-hoc signed. The app runs, but macOS does not register an ad-hoc signed widget extension, so a local build usually shows no OpenCodex widget. `build:local` always ad-hoc signs the app, so setting `MACOS_SIGN_IDENTITY` alone does not help: the widget registers only when the app and the extension are both signed by the same Developer ID team, as the release build does. Use a release build when you need the widget.

## Uninstall

Turn off **Start at Login** in the tray menu if you enabled it, then move `OpenCodex.app` from Applications to the Trash. This removes the bundled CLI and widget extension, but does not remove the proxy's `$OPENCODEX_HOME` state or a separately installed `ocx` service. The desktop app also writes an installation ID and login-item markers in its app configuration directory, plus a widget snapshot under `~/Library/Containers/com.opencodex.desktop.widget/Data/Library/Application Support/OpenCodex/snapshot.json`; moving the app to the Trash does not delete those files.
