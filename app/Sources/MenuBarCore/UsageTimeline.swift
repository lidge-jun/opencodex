import Foundation

public struct TimelineSeries: Decodable, Equatable, Sendable {
    public let id: String
    public let provider: String
    public let model: String
    public let accountLogLabel: String?
    public let total: Double
    public let points: [Double]
}

public struct TimelineAppliedFilters: Decodable, Equatable, Sendable {
    public let models: [String]?
    public let hiddenProviders: [String]
    private enum CodingKeys: String, CodingKey { case models, hiddenProviders }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        guard values.contains(.models) else {
            throw DecodingError.keyNotFound(CodingKeys.models, .init(codingPath: decoder.codingPath, debugDescription: "Missing model filter"))
        }
        models = try values.decodeIfPresent([String].self, forKey: .models)
        hiddenProviders = try values.decode([String].self, forKey: .hiddenProviders)
        guard (models?.count ?? 0) <= 100, hiddenProviders.count <= 100 else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Filter bound exceeded"))
        }
    }
}

public struct UsageTimeline: Decodable, Equatable, Sendable {
    public let start: Double
    public let end: Double
    public let bucketSeconds: Int
    public let buckets: Int
    public let metric: String
    public let aggregation: String
    public let grouping: String
    public let series: [TimelineSeries]
    public let availableModels: [String]
    public let missingMeasurements: Int
    public let truncated: Bool?
    public let appliedFilters: TimelineAppliedFilters?

    public var maxPoint: Double {
        series.flatMap(\.points).max() ?? 0
    }

    public var stackedMax: Double {
        guard buckets > 0 else { return 0 }
        return (0..<buckets).map { index in
            series.reduce(0) { $0 + ($1.points.indices.contains(index) ? $1.points[index] : 0) }
        }.max() ?? 0
    }

    public var isEmpty: Bool {
        series.allSatisfy { $0.total == 0 }
    }
}

public extension UsageTimeline {
    private enum CodingKeys: String, CodingKey {
        case start, end, bucketSeconds, buckets, metric, aggregation, grouping
        case series, availableModels, missingMeasurements, truncated, appliedFilters
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        start = try values.decode(Double.self, forKey: .start)
        end = try values.decode(Double.self, forKey: .end)
        bucketSeconds = try values.decode(Int.self, forKey: .bucketSeconds)
        buckets = try values.decode(Int.self, forKey: .buckets)
        metric = try values.decode(String.self, forKey: .metric)
        aggregation = try values.decode(String.self, forKey: .aggregation)
        grouping = try values.decode(String.self, forKey: .grouping)
        series = try values.decode([TimelineSeries].self, forKey: .series)
        availableModels = try values.decode([String].self, forKey: .availableModels)
        missingMeasurements = try values.decode(Int.self, forKey: .missingMeasurements)
        truncated = try values.decodeIfPresent(Bool.self, forKey: .truncated)
        // Optional metadata cannot discard valid chart data. An unusable receipt
        // takes the same conservative projection path as an older server.
        appliedFilters = try? values.decode(TimelineAppliedFilters.self, forKey: .appliedFilters)
    }

    func projected(_ settings: CompanionSettings) -> UsageTimeline {
        let identity: (String) -> Data = { Data($0.utf8) }
        let hidden = Set(settings.hiddenProviders.map(identity))
        let models = settings.models.map { Set($0.map(identity)) }
        let emptySelection = models?.isEmpty == true
        let active = !hidden.isEmpty || models != nil
        let matches = appliedFilters.map { receipt in
            Set(receipt.hiddenProviders.map(identity)) == hidden
                && receipt.models.map { Set($0.map(identity)) } == models
        } ?? false
        let visible = emptySelection ? [] : series.filter { row in
            if row.id == "other", row.provider.isEmpty { return !active || matches }
            return !hidden.contains(identity(row.provider))
                && (models == nil || models!.contains(identity("\(row.provider)/\(row.model)")) || models!.contains(identity(row.model)))
        }
        let available = availableModels.filter { id in
            guard let slash = id.firstIndex(of: "/") else { return true }
            return !hidden.contains(identity(String(id[..<slash])))
        }
        let uncertain = !emptySelection && (active || appliedFilters != nil) && !matches
        return UsageTimeline(start: start, end: end, bucketSeconds: bucketSeconds, buckets: buckets,
            metric: metric, aggregation: aggregation, grouping: grouping, series: visible,
            availableModels: available, missingMeasurements: missingMeasurements,
            truncated: uncertain ? true : truncated, appliedFilters: appliedFilters)
    }
}
