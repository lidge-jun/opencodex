import Foundation

public enum MenuBarTitle {
    public static func render(
        settings: CompanionSettings,
        today: UsageReport?,
        quotas: [NormalizedQuota]
    ) -> String? {
        let summary = today?.summary
        let values: [String: String] = [
            "requests": Format.count(summary?.requests),
            "totalTokens": Format.tokens(summary?.totalTokens),
            "inputTokens": Format.tokens(summary?.inputTokens),
            "outputTokens": Format.tokens(summary?.outputTokens),
            "costUsd": Format.cost(summary?.estimatedCostUsd),
            "quotaPercent": Format.percent(quotas.compactMap(\.percent).min()),
        ]
        let rendered: String
        if let template = settings.menuBarTemplate?.trimmingCharacters(in: .whitespacesAndNewlines),
           !template.isEmpty {
            rendered = values.reduce(template) { text, item in
                text.replacingOccurrences(of: "{\(item.key)}", with: item.value)
            }
        } else {
            switch settings.menuBarMetric {
            case .requests: rendered = Format.count(summary?.requests)
            case .tokens: rendered = Format.tokens(summary?.totalTokens)
            case .cost: rendered = Format.cost(summary?.estimatedCostUsd)
            case .quota: rendered = Format.percent(quotas.compactMap(\.percent).min())
            case .none: return nil
            }
        }
        let text = rendered.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if text.count <= 24 { return text }
        return String(text.prefix(23)) + "…"
    }
}
