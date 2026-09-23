import Foundation
import os
#if canImport(WidgetKit)
import WidgetKit
#endif

public struct WidgetSnapshot: Codable, Equatable, Sendable {
    public struct Today: Codable, Equatable, Sendable {
        public let requests: Int?
        public let totalTokens: Int?
        public let estimatedCostUsd: Double?

        public init(requests: Int?, totalTokens: Int?, estimatedCostUsd: Double?) {
            self.requests = requests
            self.totalTokens = totalTokens
            self.estimatedCostUsd = estimatedCostUsd
        }
    }

    public struct Quota: Codable, Equatable, Sendable {
        public let providerLabel: String
        public let windowLabel: String
        public let percent: Double?
        public let resetAt: Double?

        public init(providerLabel: String, windowLabel: String, percent: Double?, resetAt: Double?) {
            self.providerLabel = providerLabel
            self.windowLabel = windowLabel
            self.percent = percent
            self.resetAt = resetAt
        }
    }

    public struct Chart: Codable, Equatable, Sendable {
        public let start: Double
        public let bucketSeconds: Int
        public let style: String
        public let series: [Series]
        public let incomplete: Bool?

        public init(start: Double, bucketSeconds: Int, style: String, series: [Series], incomplete: Bool? = nil) {
            self.start = start
            self.bucketSeconds = bucketSeconds
            self.style = style
            self.series = series
            self.incomplete = incomplete
        }

        public struct Series: Codable, Equatable, Sendable {
            public let id: String
            public let points: [Double]

            public init(id: String, points: [Double]) {
                self.id = id
                self.points = points
            }
        }
    }

    public let schemaVersion: Int
    public let generatedAt: Double
    public let state: String
    public let stateTitle: String
    public let detail: String?
    public let endpointDisplay: String
    public let menuTitle: String?
    public let today: Today?
    public let quotas: [Quota]
    public let chart: Chart?
    public let lastUpdated: Double?

    public init(
        schemaVersion: Int, generatedAt: Double, state: String, stateTitle: String, detail: String?,
        endpointDisplay: String, menuTitle: String?, today: Today?, quotas: [Quota],
        chart: Chart?, lastUpdated: Double?
    ) {
        self.schemaVersion = schemaVersion
        self.generatedAt = generatedAt
        self.state = state
        self.stateTitle = stateTitle
        self.detail = detail
        self.endpointDisplay = endpointDisplay
        self.menuTitle = menuTitle
        self.today = today
        self.quotas = quotas
        self.chart = chart
        self.lastUpdated = lastUpdated
    }

    public static func make(from snapshot: ProxySnapshot, now: Date = Date()) -> WidgetSnapshot {
        let state: String
        switch snapshot.state {
        case .loading: state = "loading"
        case .running: state = "running"
        case .unreachable: state = "unreachable"
        case .unauthorized: state = "unauthorized"
        case .degraded: state = "degraded"
        }
        let report = snapshot.today ?? snapshot.usage
        let today = report?.filteredSummary(snapshot.settings).map {
            Today(requests: $0.requests, totalTokens: $0.totalTokens, estimatedCostUsd: $0.estimatedCostUsd)
        }
        let quotas = snapshot.quotaRows.map {
            Quota(providerLabel: $0.providerLabel, windowLabel: $0.windowLabel, percent: $0.percent, resetAt: $0.resetAt?.timeIntervalSince1970)
        }
        let chart = snapshot.timeline?.projected(snapshot.settings).mapChart(style: snapshot.settings.chartStyle.rawValue)
        return WidgetSnapshot(
            schemaVersion: 1, generatedAt: now.timeIntervalSince1970,
            state: state, stateTitle: snapshot.state.title, detail: snapshot.state.detail,
            endpointDisplay: snapshot.endpoint.display, menuTitle: snapshot.menuBarTitle,
            today: today, quotas: quotas, chart: chart,
            lastUpdated: (snapshot.timelineUpdated ?? snapshot.usageUpdated)?.timeIntervalSince1970
        )
    }
}

public final class WidgetSnapshotStore: @unchecked Sendable {
    private let fileManager: FileManager
    private let homeDirectory: URL
    private let widgetBundleID: String
    private let lock = NSLock()
    private var lastWritten: WidgetSnapshot?
    private let logger = Logger(subsystem: "ai.opencodex.menubar", category: "widget-snapshot")
    private var loggedFailures = Set<String>()

    public init(
        widgetBundleID: String = "com.opencodex.desktop.widget",
        fileManager: FileManager = .default,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
    ) {
        self.widgetBundleID = widgetBundleID
        self.fileManager = fileManager
        self.homeDirectory = homeDirectory
    }

    public var url: URL {
        homeDirectory
            .appendingPathComponent("Library/Containers/\(widgetBundleID)/Data/Library/Application Support/OpenCodex", isDirectory: true)
            .appendingPathComponent("snapshot.json")
    }

    public func write(_ snapshot: WidgetSnapshot) throws {
        let directory = url.deletingLastPathComponent()
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(snapshot)
        let temporary = directory.appendingPathComponent(".snapshot-\(UUID().uuidString).tmp")
        try data.write(to: temporary, options: .atomic)
        try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.path)
        if fileManager.fileExists(atPath: url.path) { try fileManager.removeItem(at: url) }
        try fileManager.moveItem(at: temporary, to: url)
        Self.reloadTimelines()
    }

    public func writeIfChanged(_ snapshot: WidgetSnapshot) {
        lock.lock()
        let previous = lastWritten
        if previous?.withoutGeneratedAt == snapshot.withoutGeneratedAt {
            lock.unlock()
            return
        }
        do {
            try write(snapshot)
            lastWritten = snapshot
            lock.unlock()
        } catch {
            let key = String(describing: type(of: error))
            if loggedFailures.insert(key).inserted { logger.error("Widget snapshot write failed: \(key, privacy: .public)") }
            lock.unlock()
        }
    }

    public static func reloadTimelines() {
        #if canImport(WidgetKit)
        if #available(macOS 14, *) { WidgetCenter.shared.reloadAllTimelines() }
        #endif
    }
}

private extension WidgetSnapshot {
    var withoutGeneratedAt: WidgetSnapshot {
        WidgetSnapshot(
            schemaVersion: schemaVersion, generatedAt: 0, state: state, stateTitle: stateTitle,
            detail: detail, endpointDisplay: endpointDisplay, menuTitle: menuTitle, today: today,
            quotas: quotas, chart: chart, lastUpdated: lastUpdated
        )
    }
}

private extension UsageTimeline {
    func mapChart(style: String) -> WidgetSnapshot.Chart {
        WidgetSnapshot.Chart(start: start, bucketSeconds: bucketSeconds, style: style,
            series: Array(series.prefix(6)).map { .init(id: $0.id, points: $0.points) },
            incomplete: truncated == true || missingMeasurements > 0 ? true : nil)
    }
}
