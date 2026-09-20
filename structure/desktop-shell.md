# Desktop shell

The `desktop/` tree owns the Tauri v2 OpenCodex desktop shell. Its Rust crate
discovers the loopback proxy, lazily retries management authentication, starts
the bundled `ocx` sidecar only when the configured endpoint is unreachable,
and owns the tray, autostart, single-instance, and window lifecycle behavior.

`desktop/ui/` is only a short bootstrap page. Once `/healthz` answers, the shell
navigates the webview to the proxy's loopback dashboard
(`/#/usage`) rather than bundling or serving `gui/dist` itself.
Only the bootstrap page has Tauri IPC capability; the loopback dashboard never
does because `dangerousRemoteDomainIpcAccess` is not configured.

`desktop/src-tauri/src/first_run.rs` turns Start at Login on once per installation,
before the tray is built so its checkbox reads the resulting state. A menu bar app
that is not running has no menu bar item, so leaving autostart off by default left an
installed app absent after a reboot. The marker in the app config directory is written
before the login item is touched and is never removed, so a user who turns the setting
off keeps it off; writing it afterwards would let a failed enable retry on every launch.
The behaviour is not macOS-only — the autostart plugin implements the Linux autostart
entry and the current-user Windows Run registration too.

The WidgetKit extension in `app/` needs three things that Xcode's app-extension target
would supply on its own, and SwiftPM has no such target: `@main` on
`OpenCodexWidgetBundle`, the `-e _NSExtensionMain` linker entry, and
`-application-extension` — the compiler spelling of `APPLICATION_EXTENSION_API_ONLY` — all
in `app/Package.swift`. Any one missing yields a widget that never appears: without
`@main` the linker drops the bundle and the extension registers with nothing to offer, and
without the entry override ExtensionFoundation traps during bootstrap. Nothing observable
distinguishes these from a working widget, because the bundle still builds, signs and
registers. `com.apple.security.app-sandbox` is also mandatory — `pkd` refuses to register
an unsandboxed plug-in at all — which is why the shell writes its snapshot into the
extension's own container rather than a shared App Group, which ad-hoc signing cannot use.

`desktop/scripts/prepare-sidecar.ts` maps Rust target triples to the standalone
Bun targets and prepares the external binary plus dashboard resources used by
Tauri. Generated files under desktop/src-tauri/binaries/ and
desktop/src-tauri/resources/ remain ignored.

The management API companion presence check in
`src/server/management/companion-routes.ts` accepts both
`OpenCodexMenuBar/` (legacy Swift companion) and `OpenCodexDesktop/` user agents.
This is presence telemetry only; management
authentication remains in the shared API boundary.
The desktop webview uses a Mozilla-compatible `OpenCodexDesktop/` user-agent
marker, which the GUI detects to identify the shell without using IPC.

## Release packaging and updater

The release workflow packages the desktop shell as `OpenCodex-<version>-macos.dmg`,
`OpenCodex-<version>-windows-x64.msi`, `OpenCodex-<version>-linux-x86_64.AppImage`, and
`OpenCodex-<version>-linux-amd64.deb`. Each artifact is collected with a `.sha256` file;
signed updater artifacts also carry `.sig` files. A release attachment job combines the
standalone and desktop assets, verifies checksums, and writes `latest.json` only when the
updater key secret is configured; it then requires all four platforms to have updater
signatures.
On macOS, in-app updates download `OpenCodex-<version>-macos.app.tar.gz`; the DMG is for
the first installation.

The Tauri updater public key and endpoint are checked in to
`desktop/src-tauri/tauri.conf.json`. Private updater and Apple signing credentials are
provided only as release secrets. Windows certificate signing is not wired yet, so MSI
users may see a SmartScreen warning.

## Widget snapshot

The macOS desktop shell writes the WidgetKit snapshot to
`~/Library/Containers/com.opencodex.desktop.widget/Data/Library/Application Support/OpenCodex/snapshot.json`.
The schema version is `1`; the Rust writer refreshes it every five minutes after an
immediate first write. The WidgetKit appex reads this privacy-safe file and performs no
network access.
