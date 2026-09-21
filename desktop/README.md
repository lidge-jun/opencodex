# OpenCodex desktop shell

The Tauri shell attaches to the local OpenCodex proxy and keeps the dashboard
in the proxy's loopback origin. During development:

```sh
bun run prepare-sidecar
bun run prepare-widget
bunx tauri dev
```

The sidecar is generated from the repository's standalone binary build and is
not checked into git.

The CI desktop-shell job performs Rust-only checks. It creates an empty
platform-named sidecar stub and a placeholder dashboard resource directory
solely for Tauri's external-binary and resource validation; it does not build
or run the standalone binary.

For a macOS release build, prepare the sidecar and WidgetKit extension before invoking
Tauri:

```sh
bun run prepare-sidecar
bun run prepare-widget
bunx tauri build
```

## Building locally without signing keys

`bunx tauri build` always produces the updater archive and then refuses to finish without
`TAURI_SIGNING_PRIVATE_KEY`, so a local build ends on `A public key has been found, but no private
key` **after** writing `OpenCodex.app` and the dmg. That exit code is right for a release and
misleading on a workstation.

```sh
bun run build:local
```

This asks for the host platform's installable bundles only (app and dmg on macOS, msi and nsis
setup exe on Windows, AppImage and deb on Linux), so no updater archive is produced and none is
expected to be signed. Each format is attempted in its own invocation: a format this machine
cannot bundle (for example an AppImage when a linuxdeploy dependency is missing) fails on its own
line without destroying the formats that do build, the failing format is retried once with
`--verbose` so the bundler's own diagnostics are visible, and the summary prints every format's
outcome beside the artifacts that were produced. The exit code is non-zero if any format failed.
The release path below is unchanged: a published
updater artifact still has to be signed.

## Release packaging and updates

The release workflow builds a macOS DMG, Windows MSI, Linux AppImage, and Debian package.
It collects the platform artifacts beside checksum files and creates `latest.json` for the
Tauri updater. The public updater key and endpoint live in `src-tauri/tauri.conf.json`;
the private key must never be committed. The manifest is generated only when the updater
key secret is configured and then requires all four platforms to be signed.

To package locally:

```sh
bun run build:gui
cd desktop
bun install --frozen-lockfile
bun run prepare-sidecar
bun run prepare-widget
bunx tauri build --ci --bundles app,dmg
```

Release signing is supplied through environment variables:

```sh
export TAURI_SIGNING_PRIVATE_KEY="..."
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="..."
export APPLE_CERTIFICATE="..."
export APPLE_CERTIFICATE_PASSWORD="..."
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="..."
export APPLE_PASSWORD="..."
export APPLE_TEAM_ID="..."
export MACOS_SIGN_IDENTITY="$APPLE_SIGNING_IDENTITY"
```

Generate a Tauri updater key pair with:

```sh
bunx tauri signer generate
```

Keep the private key in a local secret store. Windows SmartScreen signing is not wired
yet; the release workflow documents that installers may show an unsigned-publisher warning.
