# 010 — Phase 1: app skeleton, proxy discovery, management API client

**Depends on:** nothing (foundation phase).
**Independently verifiable by:** `swift run --package-path app MenuBarCoreTests` green and
`swift build --package-path app -c release --arch arm64` succeeding.

**Bundle scope note (audit correction):** an earlier draft closed this phase on a
`.app` produced by `scripts/build-macos-app.sh`, but that script is a Phase-4
deliverable — a phase cannot be verified by a later phase's output. Phase 1 therefore
closes on the compiler and the test suite. Phase 2 does its visual QA with `swift run`,
and **Phase 4 owns the bundle end to end**: the builder, the first `.app`, and packaging.

## File change map

| Path | Action |
| --- | --- |
| `app/Package.swift` | NEW |
| `app/Info.plist` | NEW |
| `app/Sources/MenuBarCore/Discovery.swift` | NEW |
| `app/Sources/MenuBarCore/ProxyModels.swift` | NEW |
| `app/Sources/MenuBarCore/ProxyClient.swift` | NEW |
| `app/Sources/MenuBarCore/Formatting.swift` | NEW |
| `app/Sources/MenuBarCore/Keychain.swift` | NEW |
| `app/Sources/MenuBarApp/main.swift` | NEW (minimal `NSApplication` entry; UI lands in 020) |
| `app/Sources/MenuBarCoreTests/Harness.swift` | NEW |
| `app/Sources/MenuBarCoreTests/DiscoverySuite.swift` | NEW |
| `app/Sources/MenuBarCoreTests/ModelDecodingSuite.swift` | NEW |
| `app/Sources/MenuBarCoreTests/FormattingSuite.swift` | NEW |
| `app/Sources/MenuBarCoreTests/main.swift` | NEW |
| `app/.gitignore` | NEW |
| `.gitignore` (root) | MODIFY — add `dist/macos/` |

### Build-time amendment: the test target is an executable, not a `.testTarget`

Planned as `swift test`. That does not work on this toolchain, and the failure is
environmental rather than incidental — verified during Phase 1 implementation:

```text
import XCTest
  -> error: unable to resolve module dependency: 'XCTest'

import Testing            (swift-testing)
  -> compiles, then at run time:
     Library not loaded: @rpath/Testing.framework/Versions/A/Testing
```

Xcode Command Line Tools ships neither a usable XCTest module nor the swift-testing
runtime; both require a full Xcode install. Requiring Xcode to run the unit tests of a
menu bar companion would put them out of reach of most contributors and of any CI runner
that has not selected Xcode — the same class of constraint `001` §4.1 already found for
universal builds.

**Resolution:** a ~90-line dependency-free harness (`Harness.swift`) plus an executable
target. Tests run with `swift run --package-path app MenuBarCoreTests`, exit non-zero on
failure, and print one line per case. Migration to swift-testing is mechanical if the
package ever requires full Xcode for other reasons.

**Two-target split rationale:** `MenuBarCore` is a plain library with no AppKit
dependency, so it is testable under `swift test` on any runner. `MenuBarApp` holds
everything that needs a running `NSApplication`. PR #387 used the same split and it is
the right call.

## `app/Package.swift`

```swift
// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "OpenCodexMenuBar",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "OpenCodexMenuBar", targets: ["MenuBarApp"]),
    ],
    targets: [
        .target(name: "MenuBarCore", path: "Sources/MenuBarCore"),
        .executableTarget(name: "MenuBarApp", dependencies: ["MenuBarCore"], path: "Sources/MenuBarApp"),
        .testTarget(name: "MenuBarCoreTests", dependencies: ["MenuBarCore"], path: "Tests/MenuBarCoreTests"),
    ],
    swiftLanguageVersions: [.v5]
)
```

`.macOS(.v13)` rather than #387's `.v12`: Ventura is required for
`MenuBarExtra`-adjacent APIs and modern `NSPopover` behaviour, and macOS 12 is out of
Apple's security-update window. Zero third-party dependencies is a hard rule.

## `app/Info.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>      <string>en</string>
  <key>CFBundleExecutable</key>             <string>OpenCodexMenuBar</string>
  <key>CFBundleIdentifier</key>             <string>com.opencodex.menubar</string>
  <key>CFBundleInfoDictionaryVersion</key>  <string>6.0</string>
  <key>CFBundleName</key>                   <string>OpenCodex</string>
  <key>CFBundleDisplayName</key>            <string>OpenCodex</string>
  <key>CFBundlePackageType</key>            <string>APPL</string>
  <key>CFBundleIconFile</key>               <string>OpenCodex</string>
  <key>CFBundleShortVersionString</key>     <string>0.0.0</string>
  <key>CFBundleVersion</key>                <string>0.0.0</string>
  <key>LSUIElement</key>                    <true/>
  <key>LSMinimumSystemVersion</key>         <string>13.0</string>
  <key>NSHumanReadableCopyright</key>       <string>MIT — opencodex contributors</string>
</dict>
</plist>
```

Three keys are load-bearing and an earlier draft omitted all of them, which would have
produced a bundle macOS refuses to launch:

- `CFBundleExecutable` must equal the binary name the builder copies into
  `Contents/MacOS/` — `OpenCodexMenuBar`.
- `CFBundlePackageType` must be `APPL` for the bundle to be treated as an application.
- `CFBundleIconFile` is `OpenCodex` (no extension), matching the `OpenCodex.icns` the
  builder writes into `Contents/Resources/`.

`LSUIElement` is what makes it a menu bar app: no Dock icon, no menu bar menus of its own.
The two version strings are placeholders — the build script overwrites both from
`package.json` (`040`), so the app can never claim a version the release did not ship.

## `Discovery.swift`

Implements `002` §1.

```swift
public struct ProxyEndpoint: Equatable, Sendable {
    public let host: String   // always loopback
    public let port: Int
    public var baseURL: URL { URL(string: "http://\(host):\(port)")! }
}

public enum ProxyDiscovery {
    public static let defaultPort = 10100

    public static func configDirectory(environment: [String: String] = ProcessInfo.processInfo.environment,
                                       home: URL = FileManager.default.homeDirectoryForCurrentUser) -> URL {
        if let override = environment["OPENCODEX_HOME"], !override.isEmpty {
            return URL(fileURLWithPath: (override as NSString).expandingTildeInPath)
        }
        return home.appendingPathComponent(".opencodex")
    }

    public static func resolve(configDirectory: URL) -> ProxyEndpoint {
        let file = configDirectory.appendingPathComponent("runtime-port.json")
        guard let data = try? Data(contentsOf: file),
              let record = try? JSONDecoder().decode(RuntimePortRecord.self, from: data),
              (1...65535).contains(record.port)
        else { return ProxyEndpoint(host: "127.0.0.1", port: defaultPort) }
        return ProxyEndpoint(host: "127.0.0.1", port: record.port)
    }
}

struct RuntimePortRecord: Decodable { let pid: Int?; let port: Int }
```

Host is hard-coded loopback and never read from the file. A companion that could be
pointed at an arbitrary host by a file write is a needless attack surface; the config
file only supplies a port.

`pid` is decoded but unused — `002` §1 records that a failed HTTP probe is the
authoritative liveness signal.

## `ProxyModels.swift`

Codable mirrors of the payloads in `002` §3. Every field that the proxy may omit is
optional; nothing is force-unwrapped.

```swift
public struct StartupHealth: Decodable, Equatable, Sendable {
    public let status: String?          // "protected" | "at-risk" | unknown-tolerant
    public let protection: String?
    public let platform: String?
    public let serviceRunning: Bool?
    public let serviceInstalled: Bool?
    public let serviceEnabled: Bool?
    public let rebootSafe: Bool?
    public let recommendedCommand: String?
}

/// `GET /api/config` — the ONLY source of `defaultProvider` (`002` §3).
/// `/api/settings` does not carry it; the live key set there is exactly
/// codexAutoStart · port · hostname · streamMode · startupHealth · codexRuntime.
public struct ProxyConfigSummary: Decodable, Equatable, Sendable {
    public let port: Int?
    public let hostname: String?
    public let defaultProvider: String?
}

public struct UsageSummary: Decodable, Equatable, Sendable {
    public let requests: Int?
    public let measuredRequests: Int?
    public let estimatedRequests: Int?
    public let totalTokens: Int?
    public let inputTokens: Int?
    public let outputTokens: Int?
    public let estimatedCostUsd: Double?
    public let coverageRatio: Double?
}

public struct UsageDay: Decodable, Equatable, Sendable {
    public let date: String
    public let requests: Int?
    public let totalTokens: Int?
}

public struct UsageReport: Decodable, Equatable, Sendable {
    public let range: String?
    public let generatedAt: Double?
    public let summary: UsageSummary?
    public let days: [UsageDay]?
}

public struct QuotaWindow: Decodable, Equatable, Sendable {
    public let label: String?
    public let percent: Double?
    public let resetAt: Double?
}

public struct ProviderQuota: Decodable, Equatable, Sendable {
    public let weeklyPercent: Double?
    public let monthlyPercent: Double?
    public let weeklyResetAt: Double?
    public let monthlyResetAt: Double?
    public let customWindows: [QuotaWindow]?
    public let updatedAt: Double?
}

public struct QuotaReport: Decodable, Equatable, Sendable {
    public let provider: String
    public let label: String?
    public let source: String?
    public let quota: ProviderQuota?
}

public struct ProviderSummary: Decodable, Equatable, Sendable {
    public let name: String
    public let adapter: String?
    public let authMode: String?
    public let hasApiKey: Bool?
    public let disabled: Bool?
}

public struct ProxySettings: Decodable, Equatable, Sendable {
    public let port: Int?
    public let hostname: String?
    public let streamMode: String?
}
```

`serviceInstalled` and `serviceEnabled` are decoded because `020`'s status qualifier line
renders them. They deliberately do **not** drive a restart branch — `030` establishes
that `/api/stop` stops launchd on purpose and nothing restarts the proxy automatically.

### The normalized quota view (the trap from `002` §3)

```swift
public struct NormalizedQuota: Equatable, Sendable {
    public let providerLabel: String
    public let percent: Double?
    public let windowLabel: String   // "week" | "month" | customWindows[].label
    public let resetAt: Date?
}

public extension QuotaReport {
    func normalized() -> NormalizedQuota {
        if let p = quota?.weeklyPercent {
            return .init(providerLabel: label ?? provider, percent: p, windowLabel: "week",
                         resetAt: Self.date(from: quota?.weeklyResetAt))
        }
        if let p = quota?.monthlyPercent {
            return .init(providerLabel: label ?? provider, percent: p, windowLabel: "month",
                         resetAt: Self.date(from: quota?.monthlyResetAt))
        }
        if let w = quota?.customWindows?.first {
            return .init(providerLabel: label ?? provider, percent: w.percent,
                         windowLabel: w.label ?? "window", resetAt: Self.date(from: w.resetAt))
        }
        return .init(providerLabel: label ?? provider, percent: nil, windowLabel: "—", resetAt: nil)
    }

    /// `002` §3: openai sends weeklyResetAt in SECONDS, anthropic in MILLISECONDS.
    /// Disambiguate by magnitude — 1e12 is 2001 in ms and year 33658 in s.
    static func date(from value: Double?) -> Date? {
        guard let v = value, v > 0 else { return nil }
        return Date(timeIntervalSince1970: v >= 1_000_000_000_000 ? v / 1000 : v)
    }
}
```

## `ProxyClient.swift`

```swift
public enum ProxyError: Error, Equatable {
    case unreachable            // connection refused → proxy not running
    case unauthorized           // 401 → needs a key
    case http(Int)
    case decoding
}

public actor ProxyClient {
    private let session: URLSession
    private var endpoint: ProxyEndpoint
    private var apiKey: String?

    public init(endpoint: ProxyEndpoint, session: URLSession = .shared) { ... }

    public func health() async throws -> StartupHealth
    public func settings() async throws -> ProxySettings
    public func config() async throws -> ProxyConfigSummary
    public func usage(range: UsageRange = .sevenDays) async throws -> UsageReport
    public func quotas() async throws -> [QuotaReport]
    public func providers() async throws -> [ProviderSummary]

    private func get<T: Decodable>(_ path: String) async throws -> T {
        var request = URLRequest(url: endpoint.baseURL.appendingPathComponent(path))
        request.timeoutInterval = 4
        if let key = apiKey { request.setValue(key, forHTTPHeaderField: "x-opencodex-api-key") }
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw ProxyError.decoding }
            if http.statusCode == 401 { throw ProxyError.unauthorized }
            guard (200..<300).contains(http.statusCode) else { throw ProxyError.http(http.statusCode) }
            do { return try JSONDecoder().decode(T.self, from: data) }
            catch { throw ProxyError.decoding }
        } catch let urlError as URLError
            where urlError.code == .cannotConnectToHost || urlError.code == .timedOut {
            throw ProxyError.unreachable
        }
    }
}
```

`actor` rather than a `DispatchQueue`: the client owns mutable state (`endpoint`,
`apiKey`) touched from both the polling timer and UI actions, and the actor makes that
data-race-free by construction.

`unauthorized` is a distinct case because it drives a distinct UI state — "add your API
key", not "the proxy is down". `002` §2 records that a loopback bind needs no credential,
so this path only fires for non-loopback setups.

### `UsageRange` is a closed enum, not a string

`src/usage/summary.ts:95-98` accepts exactly `7d`, `30d`, `all` and silently falls back
to `30d` for anything else. A stringly-typed range would let a caller ask for `24h`,
receive 30 days of data, and label it wrongly — which is exactly what an earlier draft of
this plan specified.

```swift
public enum UsageRange: String, Sendable {
    case sevenDays = "7d"
    case thirtyDays = "30d"
    case all
}
```

The UI additionally renders the `range` value the response actually returned, never the
one it requested (`020`).

**Privacy rule:** `ProxyError` carries no response body. Bodies can echo config values,
and `privacy:scan` forbids logging them.

## `Keychain.swift`

Thin Security.framework wrapper: `read(account:)` / `write(_:account:)` /
`delete(account:)` against `kSecClassGenericPassword`, service
`com.opencodex.menubar.apikey`. The key is never written to `UserDefaults`, never
included in an error message, and never logged. Read lazily — only after a `401`.

## `Formatting.swift`

Implements `003` §7.

```swift
public enum Format {
    public static func count(_ value: Int?) -> String      // 1,746 · 12.4K · 1.2M · 36.5B
    public static func tokens(_ value: Int?) -> String     // always SI-suffixed
    public static func cost(_ value: Double?) -> String    // $8.21 · $34.0K
    public static func relative(_ date: Date?) -> String    // "resets in 3d 4h"
}
```

Every function returns `"—"` for `nil` — never `"0"`. `003` §6 forbids fake data, and
"unknown" and "zero" are different facts.

## Tests

`DiscoveryTests`: valid record honoured · malformed JSON falls back to 10100 · missing
file falls back · out-of-range port (`0`, `70000`) falls back · `OPENCODEX_HOME` honoured
· host is loopback even when the file names another host.

`ModelDecodingTests`: decode the **verbatim live payloads captured in `002`** (not
hand-written fixtures) for health, usage, quotas, providers, config · unknown `status`
string decodes without throwing · absent `quota` normalizes to `percent: nil` · openai
seconds and anthropic milliseconds both resolve to sane 2026 dates · `ProxySettings`
decodes without a `defaultProvider` field and `ProxyConfigSummary` supplies it.

`FormattingTests`: the `002` magnitudes (`232507`, `36536664705`, `34018.25`) render as
`232K`, `36.5B`, `$34.0K` · `nil` renders `—` · zero renders `0`, not `—`.

## `app/.gitignore`

```gitignore
.build/
.swiftpm/
*.xcodeproj
DerivedData/
```

Root `.gitignore` gains `dist/macos/`. This is the direct lesson from PR #421's committed
`src-tauri/target/` — the ignore rules land in the same commit as the first build script,
never afterwards.

## Code-review corrections (round 1, folded before B closed)

An adversarial review of the first implementation returned FAIL on 10 findings. Each was
verified against the live proxy or Apple documentation before being folded:

| Finding | Correction |
| --- | --- |
| ATS blocks loopback IP loads on macOS 14+, so the *packaged* app could not reach the proxy at all while `swift run` stayed green | `Info.plist` gains `NSAppTransportSecurity` / `NSAllowsLocalNetworking` |
| The lazy Keychain retry after 401 was never wired; `Keychain` was dead production code | `CredentialStore` protocol injected into `ProxyClient`; one load, exactly one retry, no loop |
| `kSecAttrAccessible` is ignored on macOS without `kSecUseDataProtectionKeychain` | Flag set on every query; class tightened to `…ThisDeviceOnly`; `write` now updates-then-adds so a failed add cannot destroy a valid key |
| Live `kimi` reports `fiveHourPercent`/`fiveHourResetAt`; `cursor` and `google-antigravity` each carry two `customWindows`. `normalized()` discarded all but one | Added the five-hour fields and `normalizedWindows()` returning every window; `normalized()` keeps an explicit longest-horizon precedence for the compact row |
| `(requests ?? 0) == 0` turned unknown into "no usage" | `isEmptyOrUnknown: Bool?` preserves three states |
| Every non-connectivity `URLError` — including `.cancelled` — mapped to `.unreachable` | `.cancelled` propagates as `CancellationError`; other failures map to a new `.transport` case |
| `ProxyEndpoint.baseURL` force-unwrapped a URL the initializer never validated | Failable initializer; the URL is built once and stored |
| Rounding produced `1000K` instead of promoting to `1.00M` | Promotion on rollover, with boundary tests at, below, and above every unit |
| No tests covered transport, auth, or privacy | `TransportSuite`: 14 cases over status mapping, 401 retry, cancellation, request shape, and body redaction |
| The executable-test amendment was not propagated | `020`, `030`, `040` now all reference `swift run --package-path app MenuBarCoreTests` |

Live re-verification after the fixes covered all six providers, including Kimi's 5h+week
pair and Cursor's three windows.

### Round 2 (two blockers, both reentrancy/semantics rather than syntax)

| Finding | Correction |
| --- | --- |
| Concurrent initial 401s: the actor suspends across each request, so two calls could both get 401; the first loaded a key and retried while the second saw the global `didAttemptCredentialLoad` flag and failed with `.unauthorized` despite a usable key now existing | Retry eligibility is decided **per request**, against the key that request actually sent. A caller that started before the load still retries with the newly available key; a caller that already used the current key does not loop |
| `normalized()` preferred the longest horizon, so a provider at 99% of a five-hour limit and 10% monthly rendered as a green 10% row while the user was actually blocked | The compact row now selects the **highest reported usage**, with ties breaking toward the longer horizon. Live proof: Cursor's compact row moved from `month=10%` to `API usage=42%` |

Regression tests added for both: a gated concurrent-401 case asserting two successes,
one credential load, and four total requests; and pressure-selection cases covering
higher-short-window, tie-break, and unmeasured-window inputs. 51 -> 55 cases.

## Accept criteria

1. `swift run --package-path app MenuBarCoreTests` green, with the `002` payloads as
   fixtures (see the build-time amendment above).
2. `swift build --package-path app -c release --arch arm64` succeeds.
3. `UsageRange` admits only `7d`/`30d`/`all`; no call site can request `24h`.
4. `ProxyConfigSummary.defaultProvider` decodes from live `/api/config`.
5. `git status` shows no `.build/` or `dist/` entries.
6. `bun run typecheck` and `bun run test` unaffected (no TS added).
7. A live probe against the running proxy resolves the endpoint and decodes health,
   config, usage, quotas, and providers — fixtures alone do not prove the transport.
