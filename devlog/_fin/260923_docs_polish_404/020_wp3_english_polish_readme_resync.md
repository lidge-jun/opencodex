# 020 wp3 — English polish and README locale resync

## English guides (verified against code)

MODIFY `docs-site/src/content/docs/guides/macos-menu-bar.md`: replaced by the full text in
[021](021_wp3_macos_menu_bar_draft.md) (main verifies its evidence list before A>B). Topics it covers:

- Intro and "What it shows": the macOS tray belongs to the Tauri desktop app
  (`desktop/src-tauri/src/tray.rs:45`); the native usage panel shows Today, 30 days, a chart, models and
  account limits (`app/Sources/NativeTray/UsageView.swift:25`). Drop the "separate read-mostly app" and
  the four-section/provider-switch claims.
- Proxy discovery: the app asks the bundled CLI (`ocx resolve --json`, `resolve.rs:3-7,209`) instead of
  reading `runtime-port.json` itself.
- Auth: token from the environment or `$OPENCODEX_HOME/admin-api-token` (`auth.rs:19-24`), retried on
  401 (`proxy.rs:183-186`); no Keychain claim.
- Widget refresh: the tray polls every 60 s and refreshes the widget snapshot every fifth tick, about
  every five minutes (`tray.rs:236`).
- Build from source: `cd desktop`, `bun install`, `bun run prepare-sidecar`, `bun run prepare-widget`,
  `bun run build:local` for a workstation build; `bunx tauri build` needs `TAURI_SIGNING_PRIVATE_KEY`
  (`desktop/package.json:4-11`, `desktop/README.md:28-45`). Link `/guides/desktop-app/` for install.
- Gatekeeper and signing, verified on the v2.61.0 release asset (main, 2026-09-23):
  `spctl -a -t open --context context:primary-signature OpenCodex-2.61.0-macos.dmg` gives rejected,
  `source=Unnotarized Developer ID`; `xcrun stapler validate` on the DMG finds no ticket. On the mounted
  `OpenCodex.app`: `spctl -a -t exec` gives accepted, `source=Notarized Developer ID`; `stapler validate`
  works; `codesign -dv` shows `flags=0x10000(runtime)`, Developer ID Application, TeamIdentifier
  U9ATA49N28. Wording: "Release builds of OpenCodex.app are signed with a Developer ID and notarized by
  Apple, so macOS normally shows only the standard confirmation for an app downloaded from the internet."
  Fallback: "If macOS still refuses to open it, open System Settings → Privacy & Security and choose
  Open Anyway." No claim that the DMG is notarized. Local builds are ad-hoc signed unless
  `MACOS_SIGN_IDENTITY` is set.
- Keep verified claims: asset names (`desktop/scripts/collect-release-assets.ts:22`), macOS 13 app /
  macOS 14 widget (`desktop/src-tauri/tauri.conf.json:32`, `app/Widget-Info.plist:22`), Show Usage
  (`menu.rs:95-98`), six-hour update check (`updater.rs:81`).

MODIFY `docs-site/src/content/docs/guides/desktop-app.md`: exact before/after snippets in 021 for the
dashboard URL sentence (line 8), the Gatekeeper paragraph (lines 19-21, same wording as above) and the
first-launch discovery paragraph (lines 49-51, `ocx resolve`).

## README

MODIFY `README.md`:

- Desktop section (README.md:97-114), after:

  > A native shell around the same dashboard, plus a WidgetKit extension that shows proxy status,
  > today's usage and provider quotas without opening a browser. The proxy is unchanged: the app
  > finds a running one or starts the bundled `ocx` sidecar, and the dashboard stays on the proxy's
  > port (**http://localhost:10100** unless you configured another).
  >
  > It is beta. Release builds of the macOS app are signed with a Developer ID and notarized (local
  > builds are ad-hoc signed); the Windows installer is
  > not code-signed yet, so SmartScreen warns on first run. The widget needs macOS 14 or newer; the
  > snapshot model it renders lives in [`app/`](./app) (`MenuBarCore`).
  >
  > Download it from the [latest release](https://github.com/lidge-jun/opencodex/releases), or build
  > it locally: run `bun install && bun run build:gui` at the repository root, then
  > `bun install && bun run prepare-sidecar && bun run prepare-widget && bun run build:local` in `desktop/`
  > (`prepare-sidecar` bundles `gui/dist`, `desktop/scripts/prepare-sidecar.ts:58`).
  >
  > Install locations, service files and everything else written to disk are listed in
  > [`AGENTS_INSTALL.md`](./AGENTS_INSTALL.md#where-things-are-installed). The
  > [Desktop App guide](https://opencodex.me/guides/desktop-app/) and the
  > [macOS Menu Bar App guide](https://opencodex.me/guides/macos-menu-bar/) cover per-platform
  > installation and first launch.

  Windows evidence (wp3 P, 2026-09-23): the v2.61.0 MSI has no `DigitalSignature` or
  `MsiDigitalSignatureEx` stream, and neither `release.yml` nor the Tauri config configures Windows code
  signing; it ships only a Tauri updater `.sig`. The "not code-signed yet" sentence is accurate.
- Source install (README.md:207-226): both clone commands become
  `git clone -b dev https://github.com/lidge-jun/opencodex.git`; after `bun install` add
  `bun run build:gui` (macOS/Linux: `~/.bun/bin/bun run build:gui`) so `GET /` serves the dashboard
  (`docs-site/src/content/docs/getting-started/installation.md:89`). Closing sentence unchanged.
- Memory inventory section: untouched (open PR #5340).

MODIFY `readme/README.{fr,ja,ko,ru,tr,zh-CN,zh-TW}.md`: the same edits translated; docs links in the
localized form `https://opencodex.me/<docsPath>/guides/…` the parity test requires; commands
byte-identical.
MODIFY `readme/i18n-manifest.json`: every locale `sourceSha256` is the LF-normalized SHA-256 of the new
README.md.

Dispatch: seven gpt-6-sol workers, one README locale each, write scope = that one file; main computes the
manifest hash and runs the parity test.

## Acceptance

- `bun test tests/ci-workflows/docs-readme-translation-parity.test.ts tests/ci-workflows/docs-link-targets.test.ts` exit 0.
- Commits: `docs(desktop): describe the shipped macOS tray and build path` (guides) and
  `docs(readme): correct desktop and source-install claims in every locale` (README + 7 + manifest).
