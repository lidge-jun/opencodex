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

On Windows, approving **Take over** allows up to 90 seconds of startup work for the existing
runtime to stop safely, ownership to transfer, and the bundled runtime to start. Time spent
deciding at the prompt does not count toward this limit. Keep the app open while it finishes;
if it fails, use **Retry** to resolve the current runtime again.

On macOS, closing the dashboard keeps the app running in the menu bar. Open OpenCodex again from Dock or Finder to restore the dashboard without restarting the proxy.

On Windows, **Start at Login** quotes the executable path in the current-user startup
registration, including installations under `Program Files`. Previously enabled
registrations are updated once on launch. Startup entries you disabled in the tray
or Task Manager remain disabled.

## Using the ocx CLI with the desktop app

On a stable macOS app, Windows installation, or installed Linux deb, Desktop automatically
configures its bundled `ocx` for new terminals at launch. Open **Terminal command** beside
**Desktop update** in the dashboard sidebar, or **Terminal command…** in the tray menu,
to turn it off, repair it, or remove it. Turning off **Use Desktop's ocx command in new
terminals** removes the managed configuration; **Remove terminal command** also keeps
the off choice for future launches. AppImage and development launches do not configure it.

macOS and Linux use a shim in `~/.opencodex-desktop/bin`, a shared `path.sh` helper and
managed blocks in zsh, bash and fish startup files. Desktop records ownership and recovery
information in `~/.opencodex-desktop/cli.json`; deleting that record does not remove the
command or its shell blocks. The Linux deb's `/usr/bin/ocx` remains unchanged. Windows
prepends the installation directory to the user `Path`, preserving its other entries.
A command in the Windows system `Path` can still take precedence; Desktop reports that
conflict as partial configuration and does not change the system `Path`.

After enabling or repairing, open a new terminal. Check `type -a ocx` on macOS/Linux,
or `Get-Command ocx -All` and `where.exe ocx` on Windows. Existing shells, aliases,
absolute commands and later PATH changes can still select another executable.
Configuration persists after Desktop quits. If the bundle is missing, the POSIX shim
fails with repair/removal guidance instead of silently selecting another `ocx`.

On POSIX, the shim preserves shell-exported Anthropic settings when launch-proof tools
are available. If proof generation fails, and for Windows direct execution, the bundled
CLI retains its existing stripping of untrusted Anthropic environment settings.

On macOS and Linux, `ocx status` shows `Runtime supervisor: OpenCodex Desktop` when
it verifies that the desktop app runs its bundled proxy, even without recorded ownership.
Turn on **Start at Login** in the OpenCodex menu instead of installing a background
service. Startup safety credits the app only when its login registration is verified;
if it cannot be verified, follow the Desktop guidance in status.

The bundled CLI is `/Applications/OpenCodex.app/Contents/MacOS/ocx` on macOS and
`/usr/bin/ocx` for the Linux deb package. Run that executable with `status` to check
the app's proxy. Windows supervision detection is unsupported.

While the CLI detects Desktop supervising the proxy, `ocx service install`, `repair`,
`start`, and `restart` refuse before changing the service, even without recorded ownership
or verified login registration. Quit OpenCodex, then run `ocx service install` to move
startup management to the CLI. A duplicate `ocx start` names the Desktop supervisor.

Use **Check for Updates…** in the tray to update the app's bundle. `ocx update` refuses
package replacement while Desktop supervises the proxy, even for a separate npm/Bun install;
quit OpenCodex first to update that install. An accepted `ocx restart` reports that Desktop
starts the replacement and waits for it to become healthy. A newer PATH CLI cannot use
`ocx restart` to replace the app's proxy with its own runtime.

Terminal `ocx stop` still stops the proxy, but Desktop may start it again after a short
backoff. Use **Stop proxy** or **Quit** in the tray to keep it stopped. Ordinary stop prints
this reminder on stderr; `ocx stop --json` skips the supervision probe and reminder.

These guards are early warnings in current CLIs and runtimes; older versions can lack them,
and Windows does not support the supervision probe. A probe that saw Desktop but could not
finish verification also blocks the operation. Once blocked, a later inconclusive probe
does not clear it; a check must positively show no Desktop supervision. With no prior
Desktop evidence, an inconclusive or unsupported probe keeps the existing command behavior.
Recorded-ownership guards still apply independently.

## Startup safety on macOS and Linux

Startup safety reports **Desktop app** protection when fresh diagnostics verify
live supervision of the bundled proxy and that same app's **Start at Login** registration.
Recorded desktop ownership is preserved separately; supervision does not create a claim.
On Linux, the pinned autostart backend writes the login entry to
`~/.config/autostart/OpenCodex.desktop`, even when `$XDG_CONFIG_HOME` is set. Startup
safety reads that entry and the desktop install-id under `~/.config`. When
`$XDG_CONFIG_HOME` points elsewhere, the login session searches a different autostart
directory, so startup safety stays **At risk** instead of crediting the entry.
The entry counts only while it is not marked `Hidden=true` or
`X-GNOME-Autostart-enabled=false`, and has no `OnlyShowIn`, `NotShowIn`, or `TryExec`
condition. Its `Exec` must be an unquoted absolute path to `opencodex-desktop`, without
spaces, escapes, or field codes, followed by exactly `--autostart`. The resolved
executable must still be named `opencodex-desktop`, with its bundled `ocx` beside it.
Startup safety reads the full evidence chain twice and grants protection only when
both reads agree.

AppImage installations remain **At risk**: the autostart backend registers the outer
AppImage path, while the live desktop process runs inside its mount. Startup safety
cannot verify that relationship and does not credit AppImage protection.
A missing or stale check remains **At risk**. If the desktop app owns the proxy but
protection cannot be verified, reopen OpenCodex and check **Start at Login**. Service
and launcher installation or repair stays disabled while that ownership remains;
`ocx restore` is still available to undo Codex routing.

Normal desktop updates replace the bundled CLI with the fixed startup probe. No local
patch needs to be preserved across an update.

## Zoom

On macOS and Linux, Cmd (macOS) or Ctrl (Linux) with `+`, `-` and `0`, or Ctrl with the mouse wheel,
zooms the window between 50% and 300% in 10% steps, and `0` returns to 100%. The sidebar shows the
same level next to the theme switch, as `-`, the current percentage and `+`; clicking the
percentage returns to 100%. The level is
remembered and applied again the next time the app starts. The dashboard comes from the proxy the
app is attached to, so an app attached to an older proxy keeps the earlier behaviour (20% steps, not
remembered, no sidebar control) until that proxy is updated. Windows uses the browser engine's own
zoom, which is not remembered.

## Keeping the proxy running

The app keeps the proxy it started running. When that proxy restarts itself — after
**Connect as Child**, a memory restart from the dashboard, or disconnecting a Child — the app
starts the new proxy on the same port, usually within about a second (a few seconds when the proxy
already restarted in the last two minutes), and reloads the open dashboard, so the
tray's Stop still reaches it and Quit still ends it. If the proxy exits without being asked (a
crash, or `ocx stop` from a terminal), the app starts it again after a short delay that grows from
3 to 30 seconds while the proxy keeps failing. If the proxy stops answering on its port, the app
notices within about 15 seconds and recovers the same way; for a proxy it did not start (a
background service, or one you started yourself), it first waits about a minute for that proxy to
come back. While recovering, it never stops or replaces a proxy that something else already runs on
that port; it attaches to that one instead, without asking to take it over. That includes a Child's
proxy that a background service restarted after **Connect as Child**: the app attaches to it and
shows the Child's dashboard. If the port is held by something the app cannot use, such as a proxy
bound to an address other than `127.0.0.1`, the app stops retrying and waits for that to change. A
recovery that finishes while the update page is open leaves that page on screen.

The tray's **Stop proxy** and **Quit** keep the proxy stopped. The dashboard's own **Stop** button
does not stop a proxy the app runs, because the app would start it again: it says so and changes
nothing. What the app decided and why is
recorded in `runtime-supervisor.log` in the app's log directory (`~/Library/Logs/com.opencodex.desktop`
on macOS).

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
pending update remains available for retry. The app also brings back the proxy it stopped for
the install, so a failed update does not leave Codex without one. This page also works on Linux when the
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

Before uninstalling a supported Desktop installation, open **Terminal command** in the
dashboard or tray and choose **Remove terminal command**. Desktop removes only its unchanged
managed configuration. Modified blocks or files are preserved and reported; resolve those
issues before deleting the app. Uninstalling the app directly does not guarantee cleanup
of shell files or the user `Path`.

On macOS, drag `OpenCodex.app` from Applications to the Trash. On Windows, remove
OpenCodex from **Installed apps**. On Debian-based Linux systems, run:

```bash
sudo apt remove opencodex
```

For an AppImage, delete the downloaded file.

If saved menu-bar settings cannot be read, partial edits are refused to preserve the file. Restore the file or explicitly reset the companion settings before editing again.
