# Companion usage

The dashboard preview, web tray, native macOS panel and WidgetKit snapshot consume the same
companion settings. The runtime owns ledger aggregation; clients own presentation and display
filters. Companion preferences do not implicitly change general Usage API requests.

In the dashboard, `#usage` shows the usage report and `#usage/companion` shows only the Menu bar & widget settings panel. The companion view loads provider names from the report when available, or from `/api/config` when the report is empty or unavailable.

## Timeline query and response

`src/companion/settings.ts` and `src/usage/timeline.ts` share model-id validation: a nonblank
provider precedes the first slash, and the nonblank model remainder may contain more slashes.
Timeline model grouping uses the base provider label, so historical pool-account rows for one
model share one canonical `provider/model` series and one `availableModels` entry. A model filter
containing an older account-qualified id selects that entire merged series. In `modelAccount`
grouping, rows keep separate account labels: an explicit logged label wins, then the provider's
`main` or `p<hex6>` suffix, then `unknown`. On load and settings PUT,
`src/companion/settings.ts` maps saved model selections to canonical ids and removes duplicates,
so clients filtering returned rows preserve older selections.
The timeline's fixed bucket count includes the current partial interval. Its end is the next
bucket boundary; `src/server/management/usage-timeline-routes.ts` retains the rounded cache
anchor and 15-second lifetime.

Repeated `hiddenProvider` query values are explicit, bounded to 100 entries and normalized.
Each exclusion matches either the raw logged provider or its base label: a base name hides all its
pool accounts, while an account-qualified name hides only that account's attributions. The
accumulator excludes them before available-model discovery, series allocation and the top-24 fold.
Its additive `appliedFilters` response echoes the validated model ids as requested and records
deduplicated, sorted `hiddenProviders`; it introduces no credential or account-identity field.

Query builders in `gui/src/pages/usage-companion-utils.ts`,
`desktop/src-tauri/src/companion_query.rs` and `app/Sources/MenuBarCore/ProxyClient.swift`
encode nested model ids and repeated exclusions. Their projections compare filter sets
semantically, independently of ordering and duplicate entries:

- A matching echo preserves the server's correctly filtered `other` series.
- With active filters and an absent/mismatched echo, clients filter named rows, omit unknown
  folded rows and mark the chart incomplete. Older servers remain usable without false totals.
- An explicit empty model selection yields no series but retains available models for the picker.
- An unfiltered response from an older server retains its existing folded series.

The native panel uses its incomplete indicator; the widget's optional chart `incomplete` field
adds a partial-data suffix to the existing chart caption. Missing optional fields remain compatible
with old snapshots and timeline responses.

## Totals, quotas and title

`desktop/src-tauri/src/companion_usage.rs`, `gui/src/pages/tray-data.ts` and
`app/Sources/MenuBarCore/CompanionUsage.swift` preserve measured zero separately from missing
measurements. Active filters need attributable model rows: a missing/malformed row collection or
an `other/other` aggregate cannot be redistributed and remains unavailable. An intentional empty
selection is distinct from a read failure. With no filters, the original summary is preserved.
Whole-count conversion accepts only finite, nonnegative, integral values in range; costs remain
fractional. Hidden quota reports are excluded before minimum selection or visible-row truncation.

A quota window is listed only when it reports a finite percentage (zero included) or a valid reset
time. The native panel projection (`desktop/src-tauri/src/native_tray_accounts.rs`), the widget
rows (`desktop/src-tauri/src/widget.rs`, where a JSON `null` counts as absent) and the web tray
(`gui/src/pages/tray-data.ts` `quotaWindows`, also consumed by the quota summary strip) apply the
same rule, so a weekly-only plan shows only its weekly row. An account that reports no window keeps
the surface's "No quota data" line rather than a row of dashes.

Native panel provider headers carry the dashboard's own marks. `desktop/src-tauri/src/provider_icons.rs`
embeds the SVG files from `gui/public/provider-icons` and mirrors the alias table and paint modes of
`gui/src/provider-icons.ts`; `gui/tests/provider-icons-native.test.ts` fails when they drift. The
panel snapshot sends optional `iconSvg` and `iconPaint` per provider, and
`app/Sources/NativeTray/ProviderMark.swift` decodes the SVG with `NSImage`, painting `mask` marks
in the label color and `plate`/`dark-plate` marks on a constant plate; an unreadable mark shows
nothing. Quota bars there use the dashboard strip's severity thresholds (warn 70%, critical 90%).

The Tauri title reads `usage_today()`, matching the widget and retained Swift client. Every refresh
applies the resulting optional title so icon-only clears an old counter. A nonblank custom template
takes precedence over icon-only; unavailable measurements render as an em dash, not as a request
to clear the title. The update dot is independent of companion usage and title filtering. A title refresh asks the macOS status-button overlay to redraw against the current image rectangle; update availability still comes only from the Tauri updater state in desktop/src-tauri/src/updater.rs.

The native window/transport boundary remains in [Desktop shell](desktop-shell.md).

## Widget refresh

The Tauri app writes the widget snapshot from Rust (`desktop/src-tauri/src/widget.rs`) into the
extension's container. Writing and reloading are separate. The file is written whenever anything
other than `generatedAt` changed, so its `lastUpdated` is always the latest poll, and an unchanged
file is rewritten after a 15-minute heartbeat measured from its own `generatedAt`, so a restarted
app decides the same way. A reload is requested through the NativeTray export
`ocx_widget_reload_timelines` (`app/Sources/NativeTray/WidgetReload.swift`, WidgetKit on the main
queue) only when what the widget displays changed, ignoring both timestamps, and at most once
every 20 minutes; timestamp-only writes and heartbeats never reload. Apple does not define whether
a menu bar accessory app counts as foreground for the reload budget, so dashboard visibility does
not lift the limit. The widget's own 30-minute fallback timeline rereads a change that landed
inside the reload window, renders the "Updated" age as a self-updating relative date, and
schedules a stale entry at `WidgetSnapshot.staleDate` (two heartbeats after the write, owned by
`app/Sources/MenuBarCore/WidgetSnapshot.swift`). Coverage: `widget::macos` Rust tests and
`WidgetSnapshotSuite`.

Behavior coverage lives in `tests/usage/usage-timeline.test.ts`,
`tests/server/companion-settings.test.ts`, the GUI companion utility/data tests, Rust inline tests,
and `app/Sources/MenuBarCoreTests/TransportSuite.swift` and `WidgetSnapshotSuite.swift`.

Malformed optional timeline filter receipts use the older-server fallback without discarding valid series. Active filters omit untrusted folded totals and mark the projection incomplete.

If display settings cannot be read, the native panel keeps independently fetched account limits visible and reports the settings error. Usage sections remain hidden until their display preferences are available; an explicit `showAccounts: false` is honored when settings are readable.

`src/usage/ledger-retention.ts` closes its source reader after copying and before publishing the retained file, allowing replacement on Windows. The final pathname revision check still refuses replacement after a concurrent append or file replacement.

A partial settings PUT refuses unreadable or unsupported persisted content with `409 companion_settings_corrupt`. Only an explicit `reset:true` replaces that content with defaults.


Timeline model rows and available ids merge historical pool providers under their base provider,
while account grouping keeps separate labels. Legacy account-qualified model filters select the
whole merged row; hiding a base provider removes all its accounts, and hiding a raw provider removes
that account's attributions. Loaded and updated companion model selections normalize older
account-qualified ids to canonical timeline ids and deduplicate them. Coverage: `tests/usage/usage-timeline.test.ts`
and `tests/server/companion-settings.test.ts`.
