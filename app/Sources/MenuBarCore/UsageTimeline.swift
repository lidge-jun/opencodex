import Foundation

public struct TimelineSeries: Decodable, Equatable, Sendable {
    public let id: String
    public let provider: String
    public let model: String
    public let accountLogLabel: String?
    public let total: Double
    public let points: [Double]
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
