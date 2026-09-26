# 020 — PR2: reload widget timelines after the app writes a changed snapshot

## Behavior after

- `widget::write` reloads the widget's timeline when `write_if_changed` reports a write.
- The reload goes through a new NativeTray export `ocx_widget_reload_timelines`, which calls
  `WidgetCenter.shared.reloadTimelines(ofKind: "OpenCodexWidget")` on the main queue behind
  `#available(macOS 14, *)` (the static library targets macOS 13).
- Reload frequency respects WidgetKit's budget. Apple's "Keeping a widget up to date" gives a
  typical daily budget of 40-70 reloads, asks for entries at least about 5 minutes apart, and
  does not say whether a menu bar accessory app counts as "in the foreground" for the budget
  exemption, so this design assumes it does not. "Displaying dynamic dates in widgets" documents
  `Text(date, style: .relative)` as updating while visible without a reload.
- Decision: the change comparison ignores `generatedAt` and `lastUpdated`. The writer writes
  (and then reloads) when that content changed, or when the previous file is older than a
  15-minute heartbeat so the widget can still tell a live app from a stopped one. The widget
  shows its age with a relative date, treats a snapshot older than 30 minutes (two heartbeats)
  as stale, and asks WidgetKit for a fallback timeline every 15 minutes instead of 5.
- No in-memory throttle. The heartbeat reads `generatedAt` from the file already on disk, so a
  restarted app behaves the same as a running one. Writes happen at most once per tray poll
  (5 minutes) plus explicit refreshes, which bounds reloads during active use to about one
  per 5 minutes, WidgetKit's documented minimum spacing, and to four per hour when idle.

## Diff

1. `app/Sources/NativeTray/WidgetReload.swift` — `@_cdecl("ocx_widget_reload_timelines")`.
2. `desktop/src-tauri/src/widget.rs` — extern declaration; `should_write(previous, next, now)`
   pure function (content change writes; age-only change writes only past the heartbeat);
   reload only after `Ok(true)`; unit tests for all three branches plus the error path.
3. `app/Sources/MenuBarCore/WidgetSnapshot.swift` — own `staleAfter` (30 min) and
   `isStale(now:)` plus `staleDate`, moved from `OpenCodexWidget/SnapshotReader.swift` so the
   test harness can reach them. `WidgetSnapshotSuite` asserts fresh just before and stale at
   the boundary.
4. `app/Sources/OpenCodexWidget/Provider.swift` — the timeline carries the current entry and,
   when the snapshot is still fresh, a second entry dated `staleDate` marked stale, so the stale
   tint appears on time without a reload; policy `.after(15 min)`. `Views.swift` renders the
   caption with `Text(date, style: .relative)`.
4. `structure/desktop-shell.md` or `structure/companion.md` — who reloads the widget and why.

## Accept

- Rust unit tests for the decision; `swift build --package-path app` for the widget;
  NativeTray compiles through the harness and hosted macOS CI.
- Manual activation evidence is limited: reloading a live widget needs the signed app bundle,
  which this lane does not install. Hosted CI builds the bundle.
