# 040 Local app rebuild (wp4)

From the merged dev head: `bun install`, `(cd gui && bun install && bun run build)`, `cd desktop && bun run prepare-sidecar && bun run prepare-widget && bun run build:local`.
Output: `desktop/src-tauri/target/release/bundle/macos/OpenCodex.app` and dmg. Do not replace /Applications/OpenCodex.app or
restart the running proxy; hand the path to the user to install. Unsigned local build: Gatekeeper may need right-click → Open.

