import Foundation

/// Display-only wire contract. The Rust host owns network access and credential handling.
public struct NativeTraySnapshot: Decodable {
    public let schemaVersion: Int
    public let refreshing: Bool
    public let errors: [String]
    public let updatedAt: Double?
    public let settings: NativeTraySettings
    public let today: NativeTrayTotals?
    public let month: NativeTrayTotals?
    public let models: [NativeTrayModel]
    public let chart: NativeTrayChart?
    public let providers: [NativeTrayProvider]
    /// Set on the publish that reports a failed account switch.
    public let switchFailed: Bool?

    public static func decode(_ data: Data) throws -> Self {
        let snapshot = try JSONDecoder().decode(Self.self, from: data)
        guard snapshot.schemaVersion == 1 else { throw NativeTrayDecodeError.unsupportedSchema }
        return snapshot
    }
}

public enum NativeTrayDecodeError: Error { case unsupportedSchema }

public enum NativeTraySeverity: Equatable { case normal, warn, critical }

public struct NativeTraySettings: Decodable {
    public let showToday: Bool
    public let show30Days: Bool
    public let showChart: Bool
    public let showModels: Bool
    public let showAccounts: Bool
    public let showCost: Bool
    public let chartStyle: String
}

public struct NativeTrayTotals: Decodable {
    public let requests: Double?
    public let totalTokens: Double?
    public let inputTokens: Double?
    public let outputTokens: Double?
    public let cachedInputTokens: Double?
    public let estimatedCostUsd: Double?
    public let measuredRequests: Double?
    public let pricedRequests: Double?
    public let incomplete: Bool?

    public var hasMeasurements: Bool { !((requests ?? 0) > 0 && measuredRequests == 0) }
    public var tokens: Double? { hasMeasurements ? NativeTrayFormat.number(totalTokens) : nil }
    public var input: Double? { hasMeasurements ? NativeTrayFormat.number(inputTokens) : nil }
    public var output: Double? { hasMeasurements ? NativeTrayFormat.number(outputTokens) : nil }
    public var cost: Double? {
        (requests ?? 0) > 0 && pricedRequests == 0 ? nil : NativeTrayFormat.number(estimatedCostUsd)
    }
    public var costIncomplete: Bool {
        guard let requests = NativeTrayFormat.number(requests),
              let priced = NativeTrayFormat.number(pricedRequests) else { return false }
        return priced < requests
    }
    public var coverage: Double? {
        guard let requests = NativeTrayFormat.number(requests), requests > 0,
              let measured = NativeTrayFormat.number(measuredRequests) else { return nil }
        return min(100, measured / requests * 100)
    }
    public var cachedPercent: Double? {
        guard let input, input > 0, let cached = NativeTrayFormat.number(cachedInputTokens) else { return nil }
        return min(100, cached / input * 100)
    }
}

public struct NativeTrayModel: Decodable, Identifiable {
    public let id: String
    public let label: String
    public let requests: Double?
    public let tokens: Double?
}

public struct NativeTrayChart: Decodable {
    public let start: Double
    public let bucketSeconds: Double
    public let series: [Series]
    public let incomplete: Bool
    public struct Series: Decodable, Identifiable {
        public let id: String
        public let label: String
        public let points: [Double]
    }
}

public struct NativeTrayProvider: Decodable, Identifiable {
    public let id: String
    public let label: String
    public let unavailable: Bool
    public let accounts: [Account]
    /// The provider's mark as SVG markup, and how to paint it (`image`, `mask`, `plate`,
    /// `dark-plate`). Both are optional: older hosts and unknown providers send neither.
    public let iconSvg: String?
    public let iconPaint: String?
    /// Whether the host can switch this provider's active account. Absent on older hosts.
    public let switchable: Bool?
    public struct Account: Decodable, Identifiable {
        public let id: String
        public let label: String
        public let email: String?
        public let plan: String?
        public let active: Bool
        public let unavailable: Bool
        public let windows: [Window]
        /// The provider's own account id; `id` is a display key and never leaves the panel.
        public let accountId: String?
        /// `active`, `available` or `blocked`, mirroring what the runtime refuses or drains.
        public let switchState: String?
        /// `mainHardLock` or `paused` when blocked.
        public let blockedReason: String?
        /// A window reads 100%; switching is allowed and the row warns.
        public let exhausted: Bool?
        public var canSwitch: Bool { !active && switchState == "available" && accountId != nil }
    }
    public struct Window: Decodable, Identifiable {
        public let id: String
        public let label: String
        public let percent: Double?
        public let resetAt: Double?
        public var value: Double? { NativeTrayFormat.number(percent) }
        public var fill: Double { min(100, value ?? 0) / 100 }
        public var resetDate: Date? { NativeTrayFormat.date(resetAt) }
    }
}

public enum NativeTrayFormat {
    public static func number(_ value: Double?) -> Double? {
        guard let value, value.isFinite, value >= 0 else { return nil }
        return value
    }
    public static func tokens(_ value: Double?) -> String {
        guard let value = number(value) else { return "—" }
        let units: [(Double, String)] = [(1e9, "B"), (1e6, "M"), (1e3, "K")]
        let unit = units.first(where: { value >= $0.0 }) ?? (1, "")
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = unit.0 == 1 ? 0 : 1
        return (formatter.string(from: NSNumber(value: value / unit.0)) ?? "—") + unit.1
    }
    public static func date(_ timestamp: Double?) -> Date? {
        guard let timestamp = number(timestamp), timestamp > 0 else { return nil }
        let seconds = timestamp >= 1e12 ? timestamp / 1000 : timestamp
        guard seconds < 253_402_300_800 else { return nil }
        return Date(timeIntervalSince1970: seconds)
    }
    /// Same thresholds as the dashboard quota strip (`gui/src/quota-summary.ts`): warn at 70%,
    /// critical at 90%. An unknown value is never a severity.
    public static func severity(_ percent: Double?) -> NativeTraySeverity {
        guard let percent = number(percent) else { return .normal }
        if percent >= 90 { return .critical }
        if percent >= 70 { return .warn }
        return .normal
    }
    /// Visible percentage. Floored like the dashboard's `formatQuotaPercent`, so the number never
    /// reaches a threshold the bar color has not: 89.9% reads "89%" on an orange bar, never "90%".
    public static func percentText(_ percent: Double?) -> String {
        guard let percent = number(percent) else { return "—" }
        return "\(Int(percent.rounded(.down)))%"
    }
    /// VoiceOver value for a quota bar, floored the same way as the visible text.
    public static func percentDescription(_ percent: Double?) -> String {
        guard let percent = number(percent) else { return "Unavailable" }
        return "\(Int(percent.rounded(.down))) percent"
    }
    public static func reset(_ timestamp: Double?, now: Date = Date()) -> String {
        guard let date = date(timestamp), date > now else { return "—" }
        let minutes = Int(ceil(date.timeIntervalSince(now) / 60))
        if minutes < 60 { return "\(minutes)m" }
        if minutes < 1440 { return "\(minutes / 60)h \(minutes % 60)m" }
        if minutes < 10080 { return "\(minutes / 1440)d \(minutes % 1440 / 60)h" }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
}
