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
