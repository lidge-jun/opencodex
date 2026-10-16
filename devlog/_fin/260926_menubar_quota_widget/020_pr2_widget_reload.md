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
- Decision (revised after review on #5920/#5921): writing and reloading are separate.
  - The file is written whenever anything other than `generatedAt` changed, including
    `lastUpdated`, so the on-disk "Updated" time is always the latest poll; an otherwise unchanged
    file is rewritten after a 15-minute heartbeat so its `generatedAt` keeps proving the app is
    alive. Writing costs no WidgetKit budget.
  - A reload is requested only when what the widget displays changed (ignoring both
    timestamps), and at most once every 20 minutes (at most 72 a day). Timestamp-only writes and
    heartbeats never reload. Dashboard visibility does not lift the limit, because Apple does not
    define whether a menu bar accessory app counts as foreground.
  - A change that arrives inside the 20-minute window is not lost: the file already holds it and
    the widget's own fallback timeline (30 minutes) rereads it.
  - The widget shows its age with a relative date and treats a snapshot older than 30 minutes (two
    heartbeats) as stale, with a scheduled stale entry so the tint appears on time.

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
