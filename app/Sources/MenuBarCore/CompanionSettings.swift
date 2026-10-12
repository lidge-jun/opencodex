import Foundation

public struct CompanionSettings: Decodable, Equatable, Sendable {
    public enum MenuBarMetric: String, Sendable {
        case requests, tokens, cost, quota, none
    }

    public enum ChartStyle: String, Sendable {
        case line, stackedBar
    }

    public enum TokenMetric: String, Sendable {
        case total, input, output, cached
    }

    public enum Aggregation: String, Sendable {
        case sum, average, max
    }

    public enum ChartGrouping: String, Sendable {
        case model, modelAccount
    }

    public let menuBarMetric: MenuBarMetric
    public let menuBarTemplate: String?
    public let showToday: Bool
    public let showChart: Bool
    public let showModels: Bool
    public let showCost: Bool
    public let showAccounts: Bool
    public let chartHours: Int
    public let bucketMinutes: Int
    public let chartStyle: ChartStyle
    public let tokenMetric: TokenMetric
    public let aggregation: Aggregation
    public let chartGrouping: ChartGrouping
    public let models: [String]?
    public let hiddenProviders: [String]

    public static let defaults = CompanionSettings(
        menuBarMetric: .tokens, menuBarTemplate: nil,
        showToday: true, showChart: true, showModels: true, showCost: true, showAccounts: true,
        chartHours: 24, bucketMinutes: 60, chartStyle: .line, tokenMetric: .total,
        aggregation: .sum, chartGrouping: .model, models: nil, hiddenProviders: []
    )

    public init(
        menuBarMetric: MenuBarMetric = .tokens,
        menuBarTemplate: String? = nil,
        showToday: Bool = true,
        showChart: Bool = true,
        showModels: Bool = true,
        showCost: Bool = true,
        showAccounts: Bool = true,
        chartHours: Int = 24,
        bucketMinutes: Int = 60,
        chartStyle: ChartStyle = .line,
        tokenMetric: TokenMetric = .total,
        aggregation: Aggregation = .sum,
        chartGrouping: ChartGrouping = .model,
        models: [String]? = nil,
        hiddenProviders: [String] = []
    ) {
        self.menuBarMetric = menuBarMetric
        self.menuBarTemplate = menuBarTemplate
        self.showToday = showToday
        self.showChart = showChart
        self.showModels = showModels
        self.showCost = showCost
        self.showAccounts = showAccounts
        self.chartHours = chartHours
        self.bucketMinutes = bucketMinutes
        self.chartStyle = chartStyle
        self.tokenMetric = tokenMetric
        self.aggregation = aggregation
        self.chartGrouping = chartGrouping
        self.models = models
        self.hiddenProviders = hiddenProviders
    }

    private enum CodingKeys: String, CodingKey {
        case menuBarMetric, menuBarTemplate, showToday, showChart, showModels, showCost, showAccounts
        case chartHours, bucketMinutes, chartStyle, tokenMetric, aggregation, chartGrouping, models, hiddenProviders
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            menuBarMetric: Self.enumValue(MenuBarMetric.self, try c.decodeIfPresent(String.self, forKey: .menuBarMetric), default: .tokens),
            menuBarTemplate: try c.decodeIfPresent(String.self, forKey: .menuBarTemplate),
            showToday: try c.decodeIfPresent(Bool.self, forKey: .showToday) ?? true,
            showChart: try c.decodeIfPresent(Bool.self, forKey: .showChart) ?? true,
            showModels: try c.decodeIfPresent(Bool.self, forKey: .showModels) ?? true,
            showCost: try c.decodeIfPresent(Bool.self, forKey: .showCost) ?? true,
            showAccounts: try c.decodeIfPresent(Bool.self, forKey: .showAccounts) ?? true,
            chartHours: try c.decodeIfPresent(Int.self, forKey: .chartHours) ?? 24,
            bucketMinutes: try c.decodeIfPresent(Int.self, forKey: .bucketMinutes) ?? 60,
            chartStyle: Self.enumValue(ChartStyle.self, try c.decodeIfPresent(String.self, forKey: .chartStyle), default: .line),
            tokenMetric: Self.enumValue(TokenMetric.self, try c.decodeIfPresent(String.self, forKey: .tokenMetric), default: .total),
            aggregation: Self.enumValue(Aggregation.self, try c.decodeIfPresent(String.self, forKey: .aggregation), default: .sum),
            chartGrouping: Self.enumValue(ChartGrouping.self, try c.decodeIfPresent(String.self, forKey: .chartGrouping), default: .model),
            models: try c.decodeIfPresent([String].self, forKey: .models),
            hiddenProviders: try c.decodeIfPresent([String].self, forKey: .hiddenProviders) ?? []
        )
    }

    private static func enumValue<T: RawRepresentable>(
        _ type: T.Type, _ raw: String?, default value: T
    ) -> T where T.RawValue == String {
        raw.flatMap(T.init(rawValue:)) ?? value
    }
}

public struct CompanionSettingsResponse: Decodable, Equatable, Sendable {
    public let settings: CompanionSettings
    public let updatedAt: Double?
    public let corrupt: Bool?
}
