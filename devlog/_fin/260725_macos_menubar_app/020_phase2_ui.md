# 020 — Phase 2: menu bar surface and popover UI

**Depends on:** `010` (client + models + formatting must exist).
**Independently verifiable by:** a screenshot of the running app read back with
`view_image`, plus state-coverage tests.

**No `.app` bundle in this phase.** Visual QA runs the Swift executable directly
(`swift run --package-path app OpenCodexMenuBar`), which registers a menu bar item and
opens the popover exactly like a bundled build. `scripts/build-macos-app.sh` and the first
`.app` are Phase-4 deliverables; an earlier draft moved the "first launchable bundle" here
without moving the builder that produces it.

Implements the locked direction in `003`. Dials: `DESIGN_VARIANCE 2`,
`MOTION_INTENSITY 1`, density `D7`.

## File change map

| Path | Action |
| --- | --- |
| `app/Sources/MenuBarApp/main.swift` | MODIFY — replace the 010 placeholder |
| `app/Sources/MenuBarApp/AppDelegate.swift` | NEW |
| `app/Sources/MenuBarApp/StatusItemController.swift` | NEW |
| `app/Sources/MenuBarApp/StatusIcon.swift` | NEW |
| `app/Sources/MenuBarApp/PopoverViewController.swift` | NEW |
| `app/Sources/MenuBarApp/Views/StatusHeaderView.swift` | NEW |
| `app/Sources/MenuBarApp/Views/MetricsRowView.swift` | NEW |
| `app/Sources/MenuBarApp/Views/SparklineView.swift` | NEW |
| `app/Sources/MenuBarApp/Views/QuotaRowView.swift` | NEW |
| `app/Sources/MenuBarApp/Views/ActionBarView.swift` | NEW |
| `app/Sources/MenuBarApp/Theme.swift` | NEW |
| `app/Sources/MenuBarCore/ProxySnapshot.swift` | NEW |
| `app/Sources/MenuBarCore/PollingCoordinator.swift` | NEW |
| `app/Sources/MenuBarCoreTests/SnapshotStateSuite.swift` | NEW |

**AppKit, not SwiftUI.** SwiftUI in an `NSPopover` still fights sizing and first-responder
behaviour, and this layout is a fixed-width column of rows — precisely what AppKit stack
views do without ceremony. Zero-dependency and predictable beats idiomatic-but-fussy for
a surface that must render identically every time.

## `Theme.swift` — token derivation from `gui/src/styles.css`

`003` §1 established that the dashboard tokens are inherited rather than reinvented.
Where AppKit provides a semantic colour that already tracks the OS appearance, it wins
over a hardcoded hex, because it also handles increased-contrast and vibrancy.

```swift
enum Theme {
    // Surfaces: AppKit semantics track light/dark AND accessibility settings.
    static let background   = NSColor.windowBackgroundColor
    static let raised       = NSColor.controlBackgroundColor
    static let separator    = NSColor.separatorColor

    // Text: mapped from --text / --muted / --faint.
    static let text         = NSColor.labelColor
    static let muted        = NSColor.secondaryLabelColor
    static let faint        = NSColor.tertiaryLabelColor

    // State colours: taken verbatim from styles.css so the companion and the
    // dashboard agree on what "healthy" looks like.
    static let green = NSColor(light: 0x0A7D5C, dark: 0x4ECB9D)
    static let amber = NSColor(light: 0x9A4A08, dark: 0xFBBF24)
    static let red   = NSColor(light: 0xB91C1C, dark: 0xF87171)

    // Type ladder: --text-micro/caption/label/control.
    static let micro   = NSFont.systemFont(ofSize: 10, weight: .medium)
    static let caption = NSFont.systemFont(ofSize: 11)
    static let label   = NSFont.systemFont(ofSize: 12, weight: .semibold)
    static let numeric = NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .medium)

    static let gutter: CGFloat = 12   // --space-3
    static let rowGap: CGFloat = 8    // --space-2
    static let radius: CGFloat = 8    // --radius-sm
    static let width:  CGFloat = 340
}
```

`monospacedDigitSystemFont` is the AppKit equivalent of `font-variant-numeric:
tabular-nums` and is required by `003` §7 — without it, polling makes digits jitter.

`NSColor(light:dark:)` is a small `init(name:dynamicProvider:)` helper so state colours
follow the OS appearance the same way `light-dark()` does on the web.

## `ProxySnapshot.swift` — the state machine

One value type describes everything the UI can show, so every view is a pure function of
it and no view invents its own loading flag.

```swift
public enum ProxyState: Equatable, Sendable {
    case loading                        // first fetch in flight, nothing known yet
    case running(StartupHealth)
    case unreachable                    // connection refused → not running
    case unauthorized                   // 401 → needs an API key
    case degraded(String)               // reachable but errored; message is proxy-free text
}

public struct ProxySnapshot: Equatable, Sendable {
    public var state: ProxyState = .loading
    public var endpoint: ProxyEndpoint
    public var usage: UsageReport?
    public var quotas: [NormalizedQuota] = []
    public var providers: [ProviderSummary] = []
    public var lastUpdated: Date?
    public var consecutiveFailures: Int = 0
}
```

`003` §6 forbids fake data, so `usage` stays `nil` until it actually arrives; the metrics
row renders em dashes rather than zeros in the meantime.

## `PollingCoordinator.swift` — implements `002` §6

```swift
public actor PollingCoordinator {
    // 5s liveness always; 60s heavy data only while the popover is open.
    private static let livenessInterval: TimeInterval = 5
    private static let heavyInterval: TimeInterval = 60
    private static let backoffInterval: TimeInterval = 30   // after 3 consecutive failures

    public func setPopoverOpen(_ open: Bool)
    public func refreshNow() async
    public var snapshots: AsyncStream<ProxySnapshot> { get }
}
```

Heavy endpoints (`/api/usage`, `/api/provider-quotas`) are skipped entirely while the
popover is closed, and `/api/providers` is fetched only on open. After three consecutive
failures the liveness tick backs off to 30 s so a stopped proxy does not get hammered.
A menu bar app that polls a local server every 5 s forever is a battery complaint waiting
to happen.

## `StatusIcon.swift` — the signature moment (`003` §5)

```swift
enum StatusGlyph {
    static func image(for state: ProxyState) -> NSImage {
        let image: NSImage
        switch state {
        case .running(let h) where h.status == "protected": image = solidMark()
        case .running:                                      image = solidMarkNotched()
        case .loading, .degraded:                           image = outlinedMark()
        case .unreachable, .unauthorized:                   image = outlinedMark(alpha: 0.4)
        }
        image.isTemplate = true      // macOS inverts for light/dark menu bar
        return image
    }
}
```

Drawn as `NSImage(size:flipped:drawingHandler:)` vector paths at 18×18pt — no PNG assets
for the menu bar, so it stays crisp on every scale factor and inverts correctly as a
template image. No colour in the menu bar, per `003` §5.

## `PopoverViewController.swift` — layout

`NSStackView`, vertical, 340pt wide, `edgeInsets` of 12pt, spacing 8pt. Children in
urgency order per `003` §4:

1. `StatusHeaderView`
2. separator
3. `MetricsRowView` + `SparklineView`
4. separator
5. `QuotaRowView` per provider
6. separator
7. `ActionBarView`

Behaviour: `NSPopover.behavior = .transient` (click-away dismiss), `Escape` closes,
`animates = false` when reduce-motion is set.

### `StatusHeaderView`

```text
● Running          127.0.0.1:10100
  protected · service
```

Dot 8pt, `Theme.green/amber/red` by state, **always accompanied by the word** ("Running",
"Stopped", "Unreachable", "Needs API key") so meaning is never colour-only (`003` §8).
Endpoint right-aligned in `Theme.caption`/`muted`. Qualifier line renders
`health.protection` and `health.status`, and when `recommendedCommand` is present it is
shown as selectable text — displayed, never executed (`002` §3).

### `MetricsRowView`

Three columns from `/api/usage?range=7d`: REQUESTS, TOKENS, COST. Labels in
`Theme.micro` uppercase with 0.5pt tracking; values in `Theme.numeric`. All values
through `Format` (`010`), so `36536664705` becomes `36.5B` and `nil` becomes `—`.

**The range label is rendered from the response, not the request.** `002` §3 records that
`parseRange` silently falls back to `30d` for any unrecognized value, so a UI that
labelled its own request would lie whenever the server disagreed. The section header
reads `LAST 7 DAYS` only when `response.range == "7d"`.

When `summary.estimatedRequests > 0`, the requests value carries a trailing `~` with an
`accessibilityLabel` explaining the estimate — `003` §6 requires estimates to be marked.

### `SparklineView`

**Usage trend, not "activity".** One bar per element of `usage.days`, which is
day-granular — `002` §3 records that `rangeWindow()` only ever produces daily buckets and
that hourly data does not exist without a `src/` change. With `range=7d` that is 7 bars.
The bar count follows `days.count`; it is never hardcoded.

Pure `NSBezierPath` fill in `Theme.faint`, 24pt tall, no axes, no labels, no gradient.
Renders nothing (not a flat line) when data is absent.

Recent per-request activity (`GET /api/logs?tail=N`) is deliberately out of scope for v1 —
`002` §3 records the reasoning: per-request rows expose model and timing detail for the
user's real traffic, and the dashboard already presents it with proper filtering.

### `QuotaRowView`

```text
OpenAI          ▓▓▓▓▓░░░░░  44%
```

Provider label left, bar centre, percent right in `Theme.numeric`. Bar fill: `green` below
80, `amber` 80-95, `red` above 95. The percentage text is always present, so the colour is
redundant rather than load-bearing. `accessibilityValue` reads
`"44 percent of weekly quota, resets in 3d 4h"` from `NormalizedQuota` (`010`), which
already resolved the seconds/milliseconds trap.

Rows with `percent == nil` render the label and an em dash — never a zero-width bar that
looks like "0% used".

### `ActionBarView`

`Dashboard` (opens `http://127.0.0.1:<port>` in the browser) · `Stop proxy` (wired in `030`)
· `···` overflow menu (Preferences, Quit). Buttons are `.recessed` bezel, 24pt tall, with
`accessibilityLabel` on the icon-only overflow.

## State coverage (UX-STATE-01 — all four required)

| State | Header | Body | Action |
| --- | --- | --- | --- |
| `loading` | "Checking…" neutral dot | skeleton rows, em dashes | none |
| `running` | "Running" + green | live metrics, usage trend, quotas | Dashboard · Stop proxy |
| `unreachable` | "Stopped" + red | "The proxy is not running." | start command as selectable text |
| `unauthorized` | "Needs API key" + amber | "This proxy requires a key." | **Add key…** |
| `degraded` | "Degraded" + amber | last known values + staleness age | Retry |

Corrections from the Phase-0 audit, carried in from `030`:

- The `running` action is **`Stop proxy`**, never `Restart`. `/api/stop` stops launchd on
  purpose and no start endpoint exists.
- The `unreachable` action is **not** a button that starts anything. It displays the
  command to run (`ocx start`, or `ocx service start` when a service is installed) as
  selectable text, since the app never spawns processes.

### Empty states (per-section, distinct from `loading`)

`loading` means "not known yet" and correctly offers no action. **Empty means "known, and
there is nothing"** — a different fact needing different copy. Each data section defines
its own:

| Section | Empty condition | Copy | Action |
| --- | --- | --- | --- |
| Metrics | `summary` present, `requests == 0` | "No requests in this period." | Dashboard |
| Usage trend | `days` empty or all-zero | bars omitted entirely, no flat line | none |
| Quotas | `reports` empty | "No provider quota sources connected." | Dashboard |
| Providers | `providers` empty | "No providers configured." | Dashboard |

A zero is rendered as `0` only when the server actually reported zero; unknown stays an em
dash (`003` §6). Conflating the two is the fake-data tell.

Every non-running state names its next action — `dev-uiux-design` UX-STATE-01 forbids
dead-ending the user. `degraded` deliberately keeps the last known values with an explicit
"as of 2m ago" rather than blanking the popover, since stale-but-labelled beats empty.

## Tests (`SnapshotStateTests`)

`ProxyError.unreachable` → `.unreachable` · `401` → `.unauthorized` · `500` →
`.degraded` · health with `status: "protected"` → `.running` and solid glyph ·
unknown status string → `.running` with notched glyph, no crash · three failures raise
`consecutiveFailures` and trigger backoff · reduce-motion disables animation.

## Visual verification (mandatory before this phase closes)

Build, launch, open the popover, `screencapture` the region, read it back with
`view_image`, and check against `003` §6: no emoji, no gradient, no oversized type, no
colour-only meaning, numbers abbreviated and tabular, dark and light both legible. Fix
what the screenshot shows, then re-verify. Code review alone does not close this phase.

## Code-review corrections (folded before B closed)

An adversarial review that rendered every state returned FAIL on 9 findings. Each was
reproduced visually or with a stub before being folded:

| Finding | Correction |
| --- | --- |
| `Stop proxy` fired an unconfirmed destructive stop | Confirmation sheet naming the concrete consequence, since `/api/stop` also stops launchd |
| Escape did not close the popover; the accessory app never took key focus | `NSApp.activate` on open, explicit first responder, plus a scoped local key monitor installed on open and removed on close |
| Loading, unauthorized, and degraded were not really implemented | Skeleton rows and disabled chrome while loading; an actual `Add key…` button; `Retry` plus a staleness age for degraded, which now retains its last-known data |
| Popover open forced aggregation every time, while periodic refreshes fetched on-open data | Split into on-open reads (providers, config) and interval-gated aggregation (usage, quotas) |
| Overlapping refreshes could interleave, outlive a close, and mark stale data fresh | One in-flight cycle, a generation counter that discards superseded results, close bumps the generation, and only a fully successful aggregation advances the freshness timestamp |
| The at-risk notch did not render at all, so protected and at-risk looked identical | Notch carved with even-odd winding instead of a `.clear` composite that silently did nothing; verified with a rendered glyph sheet |
| `recommendedCommand` was decoded but never shown, and providers had no section | Recommended command shown as selectable text; a provider summary line with its own empty copy |
| Popover height was uncapped with no scroll region | Fixed header and actions with a scrolling body, capped at 480pt, scrollers only when content actually overflows |
| Polling tests asserted four constants and nothing else | `PollingSuite`: gating, cadence, backoff, recovery, degraded retention, and observer delivery against a stubbed transport |

Also folded: `UIProbe` now captures with `CGWindowListCreateImage` rather than `Process`,
so nothing under `app/` constructs a subprocess (`030` security rule).

### Round 2 (6 findings)

| Finding | Correction |
| --- | --- |
| Escape still did not close the popover — activating before presentation left an accessory app without key focus | Activate on the next main-loop turn *after* `show(relativeTo:)`, then set key window and first responder. Verified by synthesizing keycode 53 into the app's own queue: shown `true` before, `false` after |
| Overflowing content opened scrolled to the bottom, hiding the status and metrics | `FlippedClipView` so the scroll origin is top-anchored |
| Close-then-immediate-reopen could drop the reopen's refresh entirely | `pendingOpenRefresh` queued while a cycle holds the lock, drained on every exit path |
| Closing mid-sequence still issued later requests, and a partial aggregation failure re-fetched its healthy sibling every 5s | `isCurrent(cycle)` re-checked before each request; aggregation rate-limited on ATTEMPT, not success |
| "Retry" opened a browser | Separate `onAddKey` and `onRetry` callbacks; Retry only refreshes |
| Degraded claimed a data age derived from the last *health* probe | `healthUpdated` and `usageUpdated` split; `showsData` requires real loaded sections, and the guidance quotes `dataAge` |

The overflow menu ships `Refresh`, `Open dashboard`, and `Quit` rather than the
originally sketched `Preferences`: there is no preferences surface to open yet, and a
menu item that opens nothing is worse than its absence.

### Round 3 (3 findings) — and the amendment that resolved Escape

**`NSPopover` is replaced by a key-capable `NSPanel` (`PopoverPanel`).** This is a spec
amendment, and it was forced by measurement rather than preference. Three rounds of
Escape fixes failed because the premise was wrong. Probing the real delegate from an
accessory process showed:

```text
popover window in NSApp.windows : absent
canBecomeKey                    : false
after NSApp.activate            : appActive=true, isKey=false
after NSRunningApplication      : appActive=true, isKey=false
after raising window level      : appActive=true, isKey=false
```

macOS will not route key events to a window that cannot become key, so no activation
strategy could have worked. The same probe against `PopoverPanel`:

```text
shown=1 canBecomeKey=1 isKey=1 appActive=1
afterEscape shown=0  RESULT=ESCAPE CLOSES PANEL
```

`PopoverPanel` keeps the popover contract that matters — transient dismissal on outside
click, dismissal on losing key focus, `nonactivatingPanel` so opening does not steal
focus from the user's editor — while actually being able to receive a keystroke.

| Other finding | Correction |
| --- | --- |
| The success path's generation guard returned without draining a queued reopen | Every exit path now clears the lock and drains |
| On-open reads ran on every 5s liveness tick | Gated on `includeHeavy`, so they run only on a real open or manual refresh |
| An already-invalid cycle could consume the aggregation window | `isCurrent(cycle)` required before `lastAggregationAttempt` is set |

Also removed `lastHeavyRefresh` and `healthUpdated`, which were written but never read.
Four new polling tests cover the tick-while-open, closed-popover, partial-failure, and
degraded-without-data cases. 73 -> 77.

### Round 4 (2 findings) — the cost of the panel amendment

Replacing `NSPopover` removed two things it had been providing for free:

| Finding | Correction |
| --- | --- |
| The borderless panel had **no surface at all**: `isOpaque = false` plus a clear background composited the dashboard straight onto whatever app was underneath, so labels collided with the app behind and contrast depended on it | Content is wrapped in an `NSVisualEffectView` with `.popover` material, rounded and clipped — the surface `NSPopover` supplies automatically |
| Presenting the Stop confirmation made the alert key, which tripped `resignKey()` and tore the panel down behind it — a user who chose Cancel was left with nothing | `isPresentingModal` suspends resign-key dismissal; Cancel restores key focus, Confirm dismisses deliberately |

**Why the probe missed the first one:** `UIProbe` rendered the controller inside an
ordinary `NSWindow`, which supplies its own background. The probe now presents through
the real `PopoverPanel` over a deliberately loud backdrop, so a missing surface is
impossible to miss. This is the second time in this phase that the harness, not the
code, was the thing hiding a defect.

Also folded: `dismiss()` is now idempotent against a late monitor callback,
`debugTogglePanel()` is `#if DEBUG` only, and `applicationWillTerminate` dismisses the
panel for lifecycle symmetry.

### Round 5 (2 findings)

| Finding | Correction |
| --- | --- |
| Escape during the Stop confirmation dismissed the panel and left the alert stranded with no way to cancel | The Escape monitor now returns the event unchanged while `isPresentingModal`, so `NSAlert` handles it as Cancel |
| `tertiaryLabelColor` measured **2.01:1** in light and **2.39:1** in dark against the popover material, far under the 4.5:1 needed for text | All four tiers recalibrated against the rendered material — see the table below |

The contrast finding is worth naming precisely: AppKit's tertiary tier is intended for
disabled affordances, and it was being used for the range heading, metric captions, and
quota window labels — all information the user actually has to read. "It is a system
semantic colour" is not the same as "it is legible on this material."

### Round 6: the contrast numbers, measured properly

My first correction was itself wrong: the sampling picked the darkest pixel in a band,
which is primary `text`, not `faint`. Corrected method — count pixels matching each exact
token value in the rendered PNG, so a tier cannot be measured by sampling a different one.

Backgrounds as rendered: light `(220,219,218)`, dark `(103,102,102)`. The dark material
is not perfectly flat — the dominant pixel is `(102,101,101)` and adjacent pixels read
`(103,102,102)`. The table below uses the lighter of the two, which is the stricter test;
the 5.81:1 ceiling quoted afterwards is measured against `(102,101,101)`.

| Token | Light | Dark | Threshold |
| --- | ---: | ---: | ---: |
| `text` | 12.59:1 | 5.72:1 | 4.5 |
| `muted` | 7.86:1 | 5.11:1 | 4.5 |
| `faint` | 5.48:1 | 4.89:1 | 4.5 |
| `graphMark` | 3.58:1 | 3.79:1 | 3.0 (non-text) |

Every tier passes and `text > muted > faint` holds in both appearances.

The dark material is the binding constraint: **pure white measures only 5.81:1 against
it**, so the three text tiers have to fit inside a 1.3-point band. That is why the dark
values cluster — there is no room for the airy separation the light palette allows, and
choosing AppKit's semantic tiers instead would silently reintroduce the failure.

Contrast is measured from the rendered PNG rather than assumed from token names, and the
probe can force an appearance (`PROBE_APPEARANCE=dark`) without touching system settings.

## Accept criteria

1. Menu bar icon renders as a template image and changes with state.
2. Popover renders live data from the running proxy at 340pt.
3. All five states reachable; each except `loading` names a next action.
4. Screenshot inspected with `view_image` in both appearances.
5. Keyboard: popover opens, Tab reaches every control, Escape closes.
6. The metrics header renders the range the response returned, verified by forcing a
   fallback (`?range=bogus` → server answers `30d` → header must read `LAST 30 DAYS`).
   The `UsageRange` enum is closed, so production code cannot issue `?range=bogus`; the
   test injects a stubbed response whose `range` differs from the requested value and
   asserts the header follows the response. A direct `curl ?range=bogus` is kept only as
   server-contract evidence in `002`.
7. Sparkline bar count equals `days.count`, not a hardcoded 24.
8. Each empty state above renders its defined copy, distinct from `loading`.
9. `swift run --package-path app OpenCodexMenuBar` shows the menu bar item and popover.
10. `swift run --package-path app MenuBarCoreTests` green (see `010` build-time amendment).
