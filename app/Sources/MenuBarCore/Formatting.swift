import Foundation

/// Number and date presentation for a 340pt popover.
///
/// Live data reaches `requests: 232507`, `totalTokens: 36536664705`, and
/// `estimatedCostUsd: 34018.25`. Rendering those verbatim destroys the layout, so every
/// value is abbreviated and every unknown is an em dash — never a plausible-looking zero.
public enum Format {
    public static let unknown = "—"

    private static let grouping: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        f.groupingSeparator = ","
        f.maximumFractionDigits = 0
        return f
    }()

    /// Counts: grouped below 10 000, then SI-suffixed with 3 significant figures.
    public static func count(_ value: Int?) -> String {
        guard let value else { return unknown }
        if value < 10_000 {
            return grouping.string(from: NSNumber(value: value)) ?? String(value)
        }
        return abbreviate(Double(value))
    }

    /// Tokens are always suffixed — they are never small enough to be worth grouping.
    public static func tokens(_ value: Int?) -> String {
        guard let value else { return unknown }
        if value < 1_000 { return String(value) }
        return abbreviate(Double(value))
    }

    public static func cost(_ value: Double?) -> String {
        guard let value else { return unknown }
        if value < 1_000 {
            return String(format: "$%.2f", value)
        }
        return "$" + abbreviate(value)
    }

    public static func percent(_ value: Double?) -> String {
        guard let value else { return unknown }
        return "\(Int(value.rounded()))%"
    }

    /// "resets in 3d 4h" / "resets in 12m". Past dates read as "expired".
    public static func resetsIn(_ date: Date?, now: Date = Date()) -> String {
        guard let date else { return unknown }
        let interval = date.timeIntervalSince(now)
        guard interval > 0 else { return "expired" }

        let totalMinutes = Int(interval / 60)
        let days = totalMinutes / 1440
        let hours = (totalMinutes % 1440) / 60
        let minutes = totalMinutes % 60

        if days > 0 { return hours > 0 ? "\(days)d \(hours)h" : "\(days)d" }
        if hours > 0 { return minutes > 0 ? "\(hours)h \(minutes)m" : "\(hours)h" }
        return "\(max(minutes, 1))m"
    }

    /// "2m ago" for staleness labels on the degraded state.
    public static func age(_ date: Date?, now: Date = Date()) -> String {
        guard let date else { return unknown }
        let seconds = Int(now.timeIntervalSince(date))
        if seconds < 60 { return "just now" }
        if seconds < 3600 { return "\(seconds / 60)m ago" }
        if seconds < 86_400 { return "\(seconds / 3600)h ago" }
        return "\(seconds / 86_400)d ago"
    }

    private static func abbreviate(_ value: Double) -> String {
        let units: [(threshold: Double, suffix: String)] = [
            (1_000_000_000_000, "T"),
            (1_000_000_000, "B"),
            (1_000_000, "M"),
            (1_000, "K"),
        ]
        // Ascending, so promotion is a simple step to the next entry.
        let ascending = units.reversed().map { $0 }

        for (index, unit) in ascending.enumerated() where value < (unit.threshold * 1000) {
            let rendered = render(value / unit.threshold, suffix: unit.suffix)
            // Rounding can push a value across its own boundary: 999_999 scales to
            // 999.999K, which would render "1000K" instead of promoting to "1.00M".
            guard rendered.hasPrefix("1000"), index + 1 < ascending.count else { return rendered }
            let larger = ascending[index + 1]
            return render(value / larger.threshold, suffix: larger.suffix)
        }

        // Beyond the largest unit, stay in that unit rather than inventing a suffix.
        if let largest = ascending.last, value >= largest.threshold {
            return render(value / largest.threshold, suffix: largest.suffix)
        }
        return String(format: "%.0f", value)
    }

    /// 3 significant figures: 36.5B, 1.20M, 233K.
    private static func render(_ scaled: Double, suffix: String) -> String {
        let decimals = scaled >= 100 ? 0 : (scaled >= 10 ? 1 : 2)
        return String(format: "%.\(decimals)f%@", scaled, suffix)
    }
}
