import Foundation
import MenuBarCore

public enum ReadFailure: String, Error, Equatable, Sendable {
    case missing
    case corrupt
}

public extension WidgetSnapshot {
    func isStale(now: Date = Date()) -> Bool {
        now.timeIntervalSince1970 - generatedAt > 600
    }
}

public struct SnapshotReader: Sendable {
    public init() {}

    public func read() -> Result<WidgetSnapshot, ReadFailure> {
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let url = directory.appendingPathComponent("OpenCodex/snapshot.json")
        guard let data = try? Data(contentsOf: url) else { return .failure(.missing) }
        guard let snapshot = try? JSONDecoder().decode(WidgetSnapshot.self, from: data) else {
            return .failure(.corrupt)
        }
        return .success(snapshot)
    }

    public func isStale(_ snapshot: WidgetSnapshot, now: Date = Date()) -> Bool {
        snapshot.isStale(now: now)
    }
}
