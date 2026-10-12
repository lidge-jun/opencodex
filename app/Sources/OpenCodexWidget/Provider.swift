import Foundation
import WidgetKit
import MenuBarCore

public struct SnapshotEntry: TimelineEntry {
    public let date: Date
    public let snapshot: WidgetSnapshot?
    public let failure: ReadFailure?
    public let stale: Bool
}

public struct SnapshotProvider: TimelineProvider {
    private let reader = SnapshotReader()

    public init() {}

    public func placeholder(in context: Context) -> SnapshotEntry {
        SnapshotEntry(date: Date(), snapshot: Self.sample, failure: nil, stale: false)
    }

    public func getSnapshot(in context: Context, completion: @escaping (SnapshotEntry) -> Void) {
        completion(readEntry())
    }

    public func getTimeline(in context: Context, completion: @escaping (Timeline<SnapshotEntry>) -> Void) {
        let now = Date()
        let current = readEntry(now: now)
        var entries = [current]
        // A fresh snapshot turns stale at a known moment. Scheduling that entry up front shows the
        // stale tint on time even when WidgetKit postpones the next timeline request.
        if let snapshot = current.snapshot, !current.stale {
            entries.append(SnapshotEntry(date: snapshot.staleDate, snapshot: snapshot, failure: nil, stale: true))
        }
        // The desktop app requests a reload when what the widget shows changes (at most every 20
        // minutes) and writes every poll, so this schedule is the fallback that picks up a change
        // made inside that window. WidgetKit's documented budget is a few dozen reloads a day.
        completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(30 * 60))))
    }

    private func readEntry(now: Date = Date()) -> SnapshotEntry {
        switch reader.read() {
        case .failure(let failure):
            return SnapshotEntry(date: now, snapshot: nil, failure: failure, stale: false)
        case .success(let snapshot):
            return SnapshotEntry(date: now, snapshot: snapshot, failure: nil, stale: snapshot.isStale(now: now))
        }
    }

    private static let sample = WidgetSnapshot(
        schemaVersion: 1, generatedAt: Date().timeIntervalSince1970,
        state: "running", stateTitle: "Running", detail: "protected",
        endpointDisplay: "127.0.0.1:10100", menuTitle: "12",
        today: .init(requests: 12, totalTokens: 4_200, estimatedCostUsd: 0.12),
        quotas: [.init(providerLabel: "OpenAI", windowLabel: "week", percent: 42, resetAt: Date().addingTimeInterval(86_400).timeIntervalSince1970)],
        chart: nil, lastUpdated: Date().timeIntervalSince1970
    )
}
