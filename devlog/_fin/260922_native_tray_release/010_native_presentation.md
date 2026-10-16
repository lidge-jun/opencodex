# wp1 — Native presentation foundations

Depends on wp0. This cycle delivers native models/views with a narrow ABI, not application activation.

## File changes

- NEW `app/Sources/NativeTray/Models.swift`: `NativeTraySnapshot: Decodable` with `schemaVersion=1`, loading/refreshing flag, bounded section errors, optional updatedAt, display settings, today/thirtyDay `Totals`, model rows, timeline series, provider/account/window rows. All numeric values optional; sanitize nonfinite/negative values, clamp percentages only for bar fill, preserve actual percentages for labels; missing is never zero. Unknown schema is rejected by the update boundary. Pure Foundation formatting of tokens/reset dates.
- NEW `app/Sources/NativeTray/UsageView.swift`: SwiftUI ScrollView in fixed-width bounded native content, Today/30d sections, cached input ratio, output/cost/requests/coverage, model counts/tokens, per-account quotas with reset times, accessible missing/error state, Refresh and Dashboard/Settings actions. Use semantic system fonts/colors, no painted outer background/corner mask. Swift Charts consumes timeline ids/times and honors the actual line/stackedBar setting. Split a chart/account view sibling if cohesion/size warrants.
- NEW `app/Sources/NativeTray/Popover.swift`: main-thread controller and `@_cdecl` ABI declarations: show/toggle with borrowed status-item pointer and callback `(Int32)->Void`; hide; update with borrowed UTF-8 JSON copied during the call; visible query. `NSPopover.behavior=.transient`, `NSHostingController`, anchor to status item button, height bounded by the screen visible frame, `.onExitCommand` closes. One controller per app, no timer/network/runtime ownership in Swift.
- MODIFY `app/Package.swift`: add a static NativeTray library target/product and an executable NativeTrayTests target/product following the existing executable-test convention. Existing widget target stays intact; Rust's direct Swift build targets macOS 13 independently of the widget's package minimum.
- NEW `app/Sources/NativeTrayTests/main.swift`: fixture-based schema/number/missing-vs-zero/reset/duplicate-account identity checks, decode fixture identical to Rust wire contract. No real API/Keychain/network use.

## Contract and flow

Rust creates display DTO -> serde_json encodes -> FFI copied Data -> JSONDecoder typed snapshot -> SwiftUI render. `schemaVersion` exists at all four stages. Callback events: 1 opened/refresh, 2 closed, 3 dashboard, 4 settings; producer Swift controller, C integer serialization, Rust exhaustive match with unknown ignored, consumers refresh cancellation/main-window navigation. Unsupported values never become stop/update actions.

## Verification and acceptance

Run the actual Swift executable model tests once created; compile all NativeTray sources for macOS 13 with `swiftc` to prove availability. Fixture cases: missing usage but present quotas; measuredRequests=0; pricedRequests=0; percentages >100; reset timestamps seconds vs milliseconds; unsupported schema; Unicode labels; many accounts. UI interaction waits for wp2's installed native host. Update this plan before deviating from ABI or DTO shape. Do not claim a standalone test proves the actual app path.

## P revalidation and direct audit (wp1)

Previous D: roadmap fixes no runtime behavior; prove native availability and model semantics before integration. Source unchanged since roadmap. Clarified wire keys: `schemaVersion`, `refreshing`, `errors`, `updatedAt`, `settings`, `today`, `month`, `models`, `chart`, `providers`; display settings use showToday/show30Days/showChart/showModels/showAccounts/showCost/chartStyle. No credentials in this DTO. Chart/account subviews may live in `UsageSections.swift` to keep modules focused. Persistent native header/footer surround the bounded ScrollView, so Refresh and Dashboard stay reachable even with many accounts. AppKit screen sizing is enforced by the controller.

Direct audit: main-thread-only borrowed pointers must be copied/used synchronously; event callback must never outlive the app singleton. Reject unknown schema without replacing a valid snapshot; publish a fixed human error. Swift has no proxy client, filesystem state or new timer. Unit fixtures cover this data contract; installed UI remains a wp2 criterion. Independent consultation is NOT RUN under the user's no-subagent instruction. VERDICT: PASS.

B source recheck: companion settings have only line/stackedBar chart styles, not area/stacked. The implementation and plan now use the canonical setting. `show30Days` is a display DTO field fixed true (the existing API always shows this section), not a new persisted setting. Partial price coverage retains an asterisk and explicit tooltip.

User steering: Apple Liquid Glass is required. Add `app/Sources/NativeTray/Surface.swift` as an AppKit host controller: on macOS 26+ with a supported SDK, put the SwiftUI hosting view in `NSGlassEffectView.contentView` with regular glass. The native popover owns the sole outer clipping shape (`hasFullSizeContent` on the glass branch), with no inner rounded background. Older OS/SDK retains the native NSPopover material; no deployment-target increase. `NSGlassEffectView` availability was verified in Apple's documentation and the installed macOS 27 SDK. Respect reduced transparency through the system component. This is native API use, not CSS blur. Direct design re-audit accepts this amendment; wp2 must verify the glass branch on the actual installed app above both desktop and other windows.
