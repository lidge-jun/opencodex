# 021 wp3 — replacement text for guides/macos-menu-bar.md and desktop-app.md edits

Replace `docs-site/src/content/docs/guides/macos-menu-bar.md` with the following complete Markdown:

````markdown
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

On macOS 14 or later, open **Edit Widgets** from the desktop and add **OpenCodex**. Widget sizes show different combinations of proxy status, today's tokens and requests, estimated cost, quotas, and a usage chart. The extension reads a local snapshot written by the desktop app; that snapshot contains display data, not API keys or raw account data. The app refreshes the widget snapshot on every fifth 60-second tray tick, about every five minutes while the proxy is connected. WidgetKit also requests a new timeline after five minutes.

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

`build:local` produces the local app and DMG without requiring a Tauri updater signing key. A direct `bunx tauri build` requires `TAURI_SIGNING_PRIVATE_KEY` because it also produces an updater artifact. The widget build uses an ad-hoc signature unless `MACOS_SIGN_IDENTITY` is set; local desktop bundles are also ad-hoc signed.

## Uninstall

Turn off **Start at Login** in the tray menu if you enabled it, then move `OpenCodex.app` from Applications to the Trash. This removes the bundled CLI and widget extension, but does not remove the proxy's `$OPENCODEX_HOME` state or a separately installed `ocx` service. The desktop app also writes an installation ID and login-item markers in its app configuration directory, plus a widget snapshot under `~/Library/Containers/com.opencodex.desktop.widget/Data/Library/Application Support/OpenCodex/snapshot.json`; moving the app to the Trash does not delete those files.
````

Apply these exact replacements in `docs-site/src/content/docs/guides/desktop-app.md`:

### Opening description (current lines 6–11)

Before:

```markdown
The OpenCodex desktop app combines a native tray with the web dashboard. It discovers an
existing local proxy, or starts the bundled `ocx` sidecar when no proxy is running.

The dashboard remains available at [http://127.0.0.1:10100](http://127.0.0.1:10100).
The desktop app does not replace the proxy; it is a local shell around the dashboard and
its bundled runtime.
```

After:

```markdown
The OpenCodex desktop app combines a native tray with the web dashboard. Its bundled CLI
resolves an existing local proxy; the app starts its bundled runtime only when absence is proven.

The dashboard is served from the resolved local proxy endpoint (port `10100` by default).
The desktop app is a local shell around that dashboard and its bundled runtime.
```

### macOS first launch (current lines 17–23)

Before:

```markdown
Download `OpenCodex-<version>-macos.dmg` from the
[latest release](https://github.com/lidge-jun/opencodex/releases). Open the DMG and drag
`OpenCodex.app` to Applications.

On first launch, macOS Gatekeeper may warn that the developer cannot be verified. Right-click
the app, choose **Open**, and confirm **Open**. This build is signed for integrity but is not
yet notarized.
```

After:

```markdown
Download `OpenCodex-<version>-macos.dmg` from the
[latest release](https://github.com/lidge-jun/opencodex/releases). Open the DMG and drag
`OpenCodex.app` to Applications. The app requires macOS 13 or later.

Release builds of `OpenCodex.app` are signed with a Developer ID and notarized by Apple, so on
first launch macOS normally asks only for the standard confirmation for a downloaded app. If macOS
still blocks it, use **System Settings → Privacy & Security → Open Anyway**.
```

### Proxy startup (current lines 51–55)

Before:

```markdown
## First launch

The app first looks for an existing `ocx` proxy on loopback, using the runtime port
metadata when available and falling back to port `10100`. If no proxy answers, it starts
the bundled sidecar. The dashboard is then opened inside the app's webview.
```

After:

```markdown
## First launch

The app asks its bundled CLI to run `ocx resolve --json` and attaches to a reachable local
proxy if one is already running. It starts the bundled runtime only when the CLI proves
absence; an uncertain result is shown as a startup failure. The dashboard then opens in
the app's webview at the resolved loopback endpoint.
```

### Widget guide link (current lines 101–105)

Before:

```markdown
## Widget

The macOS app includes the OpenCodex WidgetKit extension. See the
[macOS Menu Bar App guide](/guides/macos-menu-bar/) for widget setup and the
privacy-safe snapshot details.
```

After:

```markdown
## Widget

The macOS app includes the OpenCodex WidgetKit extension. See the
[macOS Menu Bar App guide](/guides/macos-menu-bar/) for widget setup and the
local snapshot details.
```

## Evidence

- Desktop shell and bundled CLI/widget: `desktop/README.md:3-19`; `desktop/src-tauri/tauri.conf.json:17-36`; `desktop/src-tauri/src/native_tray.rs:1-4`.
- macOS and widget minimum versions: `desktop/src-tauri/tauri.conf.json:32-36`; `app/Widget-Info.plist:17-26`.
- Release-signing procedure: `.github/workflows/release.yml:275-299`, `:323-354`, `:369-386`. The specific v2.61.0 app/DMG signature, notarization, and stapling status comes from the artifact verification supplied in this task; repository code alone cannot prove the published artifact's state.
- Startup window and login-item behavior: `desktop/src-tauri/src/lib.rs:221-244`; `desktop/src-tauri/src/first_run.rs:32-69`; `desktop/src-tauri/src/startup.rs:88-96`; `desktop/src-tauri/src/tray.rs:48-55`, `:181-188`.
- Tray labels, actions, ownership gate, and quitting: `desktop/src-tauri/src/tray.rs:45-95`, `:147-228`, `:279-284`; `desktop/src-tauri/src/exit.rs:296-325`.
- Headline metrics and refresh: `desktop/src-tauri/src/tray.rs:233-265`, `:330-374`; `gui/src/pages/usage-companion-panel.tsx:24-35`, `:49-55`, `:481`.
- Native panel contents, actions, and incomplete data: `app/Sources/NativeTray/UsageView.swift:23-89`, `:93-116`; `app/Sources/NativeTray/UsageSections.swift:4-47`, `:50-109`; `desktop/src-tauri/src/native_tray.rs:83-106`, `:125-175`; `desktop/src-tauri/src/native_tray_data.rs:53-160`.
- Widget contents, local snapshot, and refresh cadence: `app/Sources/OpenCodexWidget/Views.swift:32-129`; `app/Sources/OpenCodexWidget/Provider.swift:21-36`; `app/Sources/OpenCodexWidget/SnapshotReader.swift:15-25`; `desktop/src-tauri/src/widget.rs:17-69`, `:233-278`, `:280-319`; `desktop/src-tauri/src/tray.rs:233-265`.
- Discovery, loopback, and unknown-state handling: `desktop/src-tauri/src/resolve.rs:65-76`, `:103-170`, `:173-225`; `desktop/src-tauri/src/startup.rs:515-585`.
- Token source and HTTP 401 retry: `desktop/src-tauri/src/auth.rs:9-25`; `desktop/src-tauri/src/proxy.rs:181-208`. The active desktop auth implementation reads only these sources; it has no Keychain lookup.
- Source-build commands and signing distinction: `desktop/package.json:4-12`; `desktop/scripts/prepare-sidecar.ts:37-59`; `desktop/README.md:26-54`, `:64-73`; `desktop/scripts/build-local.ts:43-63`, `:97-110`; `desktop/scripts/build-widget.sh:22-39`.
- Uninstall and remaining state: `AGENTS_INSTALL.md:61-85`, `:99-112`; `desktop/src-tauri/src/identity.rs:21-53`; `desktop/src-tauri/src/first_run.rs:5-9`, `:49-67`, `:83-110`; `desktop/src-tauri/src/widget.rs:233-237`, `:253-277`; `desktop/src-tauri/src/tray.rs:181-188`.
