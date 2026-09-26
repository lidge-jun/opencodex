# Menu bar companion: quota rows, widget refresh, provider logos, companion page

Four dependent pull requests, published as a manual chain (each child targets the parent's
head branch; the bottom targets `dev`). Each layer builds and tests on its own.

| Order | Doc | Branch | Outcome |
|---|---|---|---|
| 1 | [010](010_pr1_quota_windows.md) | `codex/menubar-quota-windows` | Quota rows appear only for windows that report data. Weekly-only accounts show one weekly row. |
| 2 | [020](020_pr2_widget_reload.md) | `codex/menubar-widget-reload` | The desktop widget redraws after the app writes a changed snapshot. |
| 3 | [030](030_pr3_provider_logos.md) | `codex/menubar-provider-logos` | Native panel provider headers carry the same SVG marks as the dashboard. |
| 4 | [040](040_pr4_companion_page.md) | `codex/usage-menubar-page` | "Menu bar & widget" is its own view at `#usage/companion` instead of a scroll anchor. |

## Evidence that started this unit

- The native panel renders "5-hour limit — —" for every Codex pro account that only reports a
  weekly window. `fn windows` in `desktop/src-tauri/src/native_tray_accounts.rs` keeps the 5h row
  whenever `monthlyPercent` is absent (`keep_unknown`). The web tray (`gui/src/pages/tray-data.ts`
  `quotaWindows`, index 0 rule) and the widget writer (`desktop/src-tauri/src/widget.rs` `quotas`,
  where a JSON `null` counts as present) share the defect. Introduced by #5452 (web) and #5490
  (native); neither states a requirement for the empty row.
- The widget snapshot on disk was 24 seconds old while the widget showed old data. The Tauri
  app writes `snapshot.json` from Rust but never calls WidgetKit; the only
  `WidgetCenter.reloadAllTimelines` call lives in `app/Sources/MenuBarCore`, which the Tauri app
  does not link.
- The native Settings action already opens `usage/companion` (`native_tray.rs`), but
  `gui/src/app-routing.ts` strips the sub-hash, so it lands on the scrolling Usage report.

## Verification strategy

No full local suite. Each layer runs its focused Bun/Rust/Swift targets, `bun run typecheck`,
`cargo fmt --check` where Rust changes, and `bun run structure:check` where an owned source
changes; exact-head hosted CI is inspected per PR. UI layers attach renders made by a temporary
offscreen SwiftUI harness (`.tmp/render`, not committed) that compiles the branch's
`app/Sources/NativeTray` sources; the installed desktop app is never replaced.

## Architect consultation

Read-only gpt-6-sol architect proposal D1-D4 (2026-09-26). Dispositions: D1 accepted; D2
accepted with reload frequency bounded by WidgetKit's documented budget (see 020); D3 amended:
a Rust mapping table plus a Bun parity test against `gui/src/provider-icons.ts` replaces a
shared manifest, which would have rewritten the GUI icon module; D4 accepted.

