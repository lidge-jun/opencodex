# wp1 verification

## Automated and build proof

- `swift run --package-path app NativeTrayTests`: PASS, 26 assertions. Fixture scope: schema/malformed response, unknown vs measured zero, absent usage with available account quota, pricing coverage, Unicode, 80-provider roster, reset units/date bounds and >100% quota bar.
- `swiftc -parse-as-library -emit-library -static -module-name NativeTray -target arm64-apple-macos13.0 app/Sources/NativeTray/*.swift ...`: exit 0, including the runtime-gated Apple Liquid Glass source. This proves the desktop deployment minimum is not raised to the WidgetKit package minimum.
- Rust link probe referencing the actual NativeTray static archive with SwiftUI/Charts/AppKit: exit 0. No swift-autolink-extract dependency.
- `bun run structure:check`: PASS after documenting the library owner.

## Render and adversarial pass

Used a temporary native NSWindow/NSHostingController host with synthetic usage and 40 synthetic account providers, at 420 x 660 content points. This is native view proof, not a claim that the installed application already uses it.

| Scenario | Observation | Evidence |
|---|---|---|
| Populated content | Native totals, chart, models and provider rows render; no webview or raster substitute | `evidence/native-glass-top.png` |
| Long list | Native scroll reaches Example Provider 40; scrollbar value 1; fixed header/footer remain visible | `evidence/native-glass-bottom.png` |
| Missing values | Synthetic month omits input/output/cost; UI shows em dashes | top capture + model assertions |
| Partial price coverage | Today displays $2.50* for 30 priced out of 40 requests | top capture + model assertions |
| CJK/model boundaries | Unicode survives decoding; no credentials or real user account data in fixtures | 26-assertion executable |
| Apple glass | Native host includes NSGlassEffectView on this macOS 27 build; final anchored popover/background composition remains a wp2 acceptance item | Surface.swift + captures |

A test-host sizing issue was found: assigning NSHostingController resets a window to its fitting size. The test host now sets content size after assigning its controller; the production NSPopover likewise sets contentSize after constructing its controller. The first test-host screenshot was rejected; only corrected captures are evidence.

Main performed functional and visual review separately; independent reviewers were not used because the user explicitly forbade subagents. The actual menu icon, live transport, outside-click/Escape lifecycle and glass above background windows still require wp2 integration proof. No production-app completion claim is made in this cycle.

Teardown: temporary NativeTrayPreview process terminated; no proxy/server or user configuration was created by this fixture. Temporary source/build artifacts are retained in ignored scratch space for reproducibility.

D direction: native presentation foundation is ready. Continue wp2 with the prewritten bridge/transport/packaging plan, including a release-builder check that the published macOS artifact was built with Liquid Glass-capable SDK (not merely runtime availability on this host).

Capture integrity: CUA supplied JPEG bytes despite the scratch `.png` name. Re-encoded those unchanged pixels to actual PNG before committing; verified PNG signature and 420x692 dimensions (420x660 content plus native titlebar). This correction does not synthesize or edit UI content. Functional pass checks FE-A11Y-POLISH-01 (persistent actions and accessible controls); visual pass checks bounded content and native-system styling. Both passes are main-owned under no-delegation. Headless browser from the preceding CSS investigation was also stopped.
