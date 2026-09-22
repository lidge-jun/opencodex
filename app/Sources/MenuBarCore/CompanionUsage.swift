import Foundation

public extension UsageReport {
    /// Unknown folded attribution cannot be safely redistributed after a display filter.
    func filteredSummary(_ settings: CompanionSettings) -> UsageSummary? {
        if settings.models == nil && settings.hiddenProviders.isEmpty { return summary }
        guard summary != nil else { return nil }
        let emptySelection = settings.models?.isEmpty == true
        let rows: [UsageModelRow]
        if emptySelection { rows = [] }
        else {
            guard let models, models.allSatisfy({ row in
                guard let provider = row.provider, let model = row.model else { return false }
                return !provider.isEmpty && !model.isEmpty && !(provider == "other" && model == "other")
            }) else { return nil }
            let hidden = Set(settings.hiddenProviders)
            let selected = settings.models.map(Set.init)
            rows = models.filter { row in
                !hidden.contains(row.provider!) && (selected == nil
                    || selected!.contains("\(row.provider!)/\(row.model!)") || selected!.contains(row.model!))
            }
        }
        func sum(_ key: KeyPath<UsageModelRow, Int?>) -> Int? {
            guard !rows.isEmpty else { return nil }
            var total = 0
            for row in rows {
                guard let value = row[keyPath: key], value >= 0 else { return nil }
                let next = total.addingReportingOverflow(value)
                guard !next.overflow else { return nil }
                total = next.partialValue
            }
            return total
        }
        var cost: Double? = rows.isEmpty ? nil : 0
        for row in rows {
            guard let value = row.estimatedCostUsd, value.isFinite, value >= 0, let previous = cost,
                  (previous + value).isFinite else { cost = nil; break }
            cost = previous + value
        }
        let requests = sum(\.requests), measured = sum(\.measuredRequests)
        let coverage = requests.flatMap { count in
            measured.flatMap { count > 0 && $0 <= count ? Double($0) / Double(count) : nil }
        }
        return UsageSummary(requests: requests, measuredRequests: measured, estimatedRequests: sum(\.estimatedRequests),
            totalTokens: sum(\.totalTokens), inputTokens: sum(\.inputTokens), outputTokens: sum(\.outputTokens),
            estimatedCostUsd: cost, coverageRatio: coverage)
    }
}
