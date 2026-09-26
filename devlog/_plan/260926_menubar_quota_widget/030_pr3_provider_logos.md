# 030 — PR3: provider SVG marks in the native panel

## Behavior after

- Each provider header in the native panel shows the provider's mark at 14 pt next to its label.
- Marks come from `gui/public/provider-icons`, embedded into the desktop binary with
  `include_str!`, and are sent as an optional `iconSvg` string on each provider object in the
  panel snapshot. Older payloads without the field decode unchanged.
- Paint follows the GUI's four modes in `gui/src/provider-icons.ts`: `mask` renders as a
  template image tinted with the label color, `plate` and `dark-plate` draw the mark on a light
  or dark rounded plate, `image` renders the colors as-is. The mode travels as `iconPaint`.
- Unknown providers, or data `NSImage` cannot decode, show no mark; the label layout does not
  shift.

## Diff

1. `desktop/src-tauri/src/provider_icons.rs` (registered in `lib.rs`) — alias table covering
   every alias in `provider-icons.ts`, `include_str!` per file, paint mode per file.
2. `desktop/src-tauri/src/native_tray_accounts.rs` — add optional `iconSvg` and `iconPaint`.
3. `app/Sources/NativeTray/Models.swift`, `UsageSections.swift` — decode and render, cached per id.
4. `gui/tests/` — parity test: the Rust alias set equals the TS alias set, each alias maps to
   the same file and paint mode, and every referenced file exists. An omitted alias fails.

## Accept

- `app/Sources/NativeTrayTests/main.swift` decodes one representative file per paint mode
  (`openai.svg` image, `grok.svg` mask, `zai.svg` plate, `nebius.svg` dark-plate) from
  `gui/public/provider-icons` through the same decode function the view uses, and asserts a
  non-empty size; malformed data returns nil. Runs in hosted macOS CI.
- Parity test, Rust tests, light and dark harness renders of all four modes.
- Contingency: if the decode test fails on the hosted macOS runner, PR3 does not ship with
  silently missing marks. It converts the table's files to single-page PDF at build time
  (`NSImage` decodes PDF on every supported macOS), carries that data instead, and the same
  test asserts the same view decoder on the converted data.
- `include_str!` reaches `gui/public` from the repository checkout that CI and release builds
  use; the desktop crate is never published standalone.
