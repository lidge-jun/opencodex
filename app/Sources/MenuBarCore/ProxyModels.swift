import Foundation

// Codable mirrors of the management API payloads inventoried in
// devlog/_plan/260725_macos_menubar_app/002_api_surface.md.
//
// Every field the proxy may omit is optional. The proxy is a fast-moving local service;
// a companion that fails to decode because one field moved is worse than one that shows
// an em dash.

/// `GET /api/startup-health`
public struct StartupHealth: Decodable, Equatable, Sendable {
    public let status: String?
    public let protection: String?
    public let platform: String?
    public let routingKind: String?
    public let serviceRunning: Bool?
    public let serviceInstalled: Bool?
    public let serviceEnabled: Bool?
    public let rebootSafe: Bool?
    public let recommendedCommand: String?

    public init(
        status: String? = nil,
        protection: String? = nil,
        platform: String? = nil,
        routingKind: String? = nil,
        serviceRunning: Bool? = nil,
        serviceInstalled: Bool? = nil,
        serviceEnabled: Bool? = nil,
        rebootSafe: Bool? = nil,
        recommendedCommand: String? = nil
    ) {
        self.status = status
        self.protection = protection
        self.platform = platform
        self.routingKind = routingKind
        self.serviceRunning = serviceRunning
        self.serviceInstalled = serviceInstalled
        self.serviceEnabled = serviceEnabled
        self.rebootSafe = rebootSafe
        self.recommendedCommand = recommendedCommand
    }

    /// `status` is treated as an open string: unknown values degrade to a neutral state
    /// rather than crashing or being coerced into "healthy".
    public var isProtected: Bool { status == "protected" }

    /// True when a supervisor owns the process lifecycle. Used only for the qualifier
    /// line — it deliberately does not gate any action, because `/api/stop` stops the
    /// service on purpose and nothing restarts the proxy automatically.
    public var isServiceManaged: Bool {
        (serviceInstalled ?? false) && (serviceEnabled ?? false)
    }

    /// The command to show the user when the proxy is not running.
    public var manualStartCommand: String {
        isServiceManaged ? "ocx service start" : "ocx start"
    }
}

/// `GET /api/settings`. Note the absence of `defaultProvider` — it lives on
/// `/api/config`, verified against the live key set.
public struct ProxySettings: Decodable, Equatable, Sendable {
    public let port: Int?
    public let hostname: String?
    public let streamMode: String?
    public let codexAutoStart: Bool?
}

/// `GET /api/config` — the only source of `defaultProvider`.
public struct ProxyConfigSummary: Decodable, Equatable, Sendable {
    public let port: Int?
    public let hostname: String?
    public let defaultProvider: String?
}

/// Ranges accepted by `parseRange()` in `src/usage/summary.ts`.
///
/// Closed on purpose: the server silently degrades anything else to `30d`, so a
/// stringly-typed range would let a caller ask for `24h`, receive thirty days of data,
/// and label it wrongly.
public enum UsageRange: String, Sendable, CaseIterable {
    case today = "today"
    case sevenDays = "7d"
    case thirtyDays = "30d"
    case all
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

    public var hasEstimates: Bool { (estimatedRequests ?? 0) > 0 }
}

public struct UsageDay: Decodable, Equatable, Sendable {
    public let date: String
    public let requests: Int?
    public let totalTokens: Int?
}

public struct UsageReport: Decodable, Equatable, Sendable {
    public let range: String?
    public let surface: String?
    public let generatedAt: Double?
    public let summary: UsageSummary?
    public let days: [UsageDay]?
    public let models: [UsageModelRow]?
    public let accounts: [UsageAccountRow]?

    /// The range the server actually applied, which is not always the one requested.
    public var effectiveRange: UsageRange? {
        range.flatMap(UsageRange.init(rawValue:))
    }

    /// Header text driven by the response, never by the request.
    public var rangeLabel: String {
        switch effectiveRange {
        case .today: return "TODAY"
        case .sevenDays: return "LAST 7 DAYS"
        case .thirtyDays: return "LAST 30 DAYS"
        case .all: return "ALL TIME"
        case nil: return "USAGE"
        }
    }

    public var isEmpty: Bool {
        isEmptyOrUnknown == true
    }

    /// Three states, not two: `nil` means the proxy did not report a request count, and
    /// `true` means it explicitly reported zero. Collapsing those would let the UI print
    /// "No requests" for data it simply does not have.
    public var isEmptyOrUnknown: Bool? {
        guard let requests = summary?.requests else { return nil }
        return requests == 0
    }
}

public struct UsageModelRow: Decodable, Equatable, Sendable {
    public let provider: String?
    public let model: String?
    public let requests: Int?
    public let measuredRequests: Int?
    public let estimatedRequests: Int?
    public let inputTokens: Int?
    public let outputTokens: Int?
    public let totalTokens: Int?
    public let estimatedCostUsd: Double?
}

public struct UsageAccountRow: Decodable, Equatable, Sendable {
    public let accountLogLabel: String?
    public let requests: Int?
    public let totalTokens: Int?
    public let estimatedCostUsd: Double?
}

public struct QuotaWindow: Decodable, Equatable, Sendable {
    public let label: String?
    public let percent: Double?
    public let resetAt: Double?
}

public struct ProviderQuota: Decodable, Equatable, Sendable {
    public let weeklyPercent: Double?
    public let monthlyPercent: Double?
    public let fiveHourPercent: Double?
    public let weeklyResetAt: Double?
    public let monthlyResetAt: Double?
    public let fiveHourResetAt: Double?
    public let customWindows: [QuotaWindow]?
    public let updatedAt: Double?
}

public struct QuotaReport: Decodable, Equatable, Sendable {
    public let provider: String
    public let label: String?
    public let source: String?
    public let quota: ProviderQuota?
}

/// A provider-agnostic view of quota, since the window key differs per provider.
public struct NormalizedQuota: Equatable, Sendable {
    public let provider: String
    public let providerLabel: String
    public let percent: Double?
    public let windowLabel: String
    public let resetAt: Date?

    public var hasPercent: Bool { percent != nil }
}

public extension QuotaReport {
    /// Timestamps in this payload are not uniform: the live proxy returns
    /// `weeklyResetAt` in seconds for `openai` and in milliseconds for `anthropic`,
    /// within the same array. Disambiguate by magnitude — 1e12 is 2001 read as
    /// milliseconds and year 33658 read as seconds, so the boundary is unambiguous for
    /// any timestamp this app will ever see.
    static func date(from value: Double?) -> Date? {
        guard let value, value > 0 else { return nil }
        let seconds = value >= 1_000_000_000_000 ? value / 1000 : value
        return Date(timeIntervalSince1970: seconds)
    }

    /// Every window the provider reported, in display order.
    ///
    /// The live proxy is not uniform: `openai` and `xai` report a single named window,
    /// `kimi` reports both `weeklyPercent` and `fiveHourPercent`, and `cursor` and
    /// `google-antigravity` carry two `customWindows` each. Returning only one window
    /// would silently hide real quota pressure.
    func normalizedWindows() -> [NormalizedQuota] {
        let name = label ?? provider
        var windows: [NormalizedQuota] = []

        func append(_ percent: Double?, _ windowLabel: String, _ resetAt: Double?) {
            guard percent != nil || resetAt != nil else { return }
            windows.append(NormalizedQuota(
                provider: provider, providerLabel: name, percent: percent,
                windowLabel: windowLabel, resetAt: Self.date(from: resetAt)
            ))
        }

        append(quota?.fiveHourPercent, "5h", quota?.fiveHourResetAt)
        append(quota?.weeklyPercent, "week", quota?.weeklyResetAt)
        append(quota?.monthlyPercent, "month", quota?.monthlyResetAt)

        for window in quota?.customWindows ?? [] {
            append(window.percent, window.label ?? "window", window.resetAt)
        }

        return windows
    }

    /// The single window that best represents current pressure, for the compact row.
    ///
    /// Selection is **highest reported usage**, not longest horizon. Every window can
    /// stop work: a provider at 99% of a five-hour limit and 10% of its monthly limit is
    /// blocked right now, and showing the monthly 10% would paint that row green while
    /// the user cannot make a request. Ties break toward the longer horizon, since that
    /// is the one that will not recover on its own.
    ///
    /// Providers with no numeric window normalize to a nil percent so the UI renders an
    /// em dash rather than a misleading zero.
    func normalized() -> NormalizedQuota {
        let name = label ?? provider
        let windows = normalizedWindows()

        // Longer horizons rank higher only as a tie-breaker.
        func horizonRank(_ label: String) -> Int {
            switch label {
            case "month": return 3
            case "week": return 2
            case "5h": return 1
            default: return 0
            }
        }

        let measured = windows.filter(\.hasPercent)
        let preferred = measured.max { lhs, rhs in
            let left = lhs.percent ?? 0
            let right = rhs.percent ?? 0
            if left != right { return left < right }
            return horizonRank(lhs.windowLabel) < horizonRank(rhs.windowLabel)
        } ?? windows.first

        return preferred ?? NormalizedQuota(
            provider: provider, providerLabel: name, percent: nil,
            windowLabel: "—", resetAt: nil
        )
    }
}

/// `GET /api/providers`. `hasApiKey` is a presence flag; the key never leaves the proxy.
public struct ProviderSummary: Decodable, Equatable, Sendable {
    public let name: String
    public let adapter: String?
    public let authMode: String?
    public let hasApiKey: Bool?
    public let disabled: Bool?

    public var isEnabled: Bool { !(disabled ?? false) }
}
