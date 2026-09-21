import Foundation
import MenuBarCore

enum WidgetSnapshotSuite {
    static func run(_ t: TestRunner) {
        t.test("widget snapshot: maps today and caps chart series") {
            var series: [String] = []
            for index in 0..<7 {
                series.append(#"{"id":"s\#(index)","provider":"p","model":"m\#(index)","total":1,"points":[1]}"#)
            }
            let timelineJSON = #"{"start":1,"end":2,"bucketSeconds":60,"buckets":1,"metric":"total","aggregation":"sum","grouping":"model","series":[\#(series.joined(separator: ","))],"availableModels":[],"missingMeasurements":0}"#
            let timeline = try! JSONDecoder().decode(UsageTimeline.self, from: Data(timelineJSON.utf8))
            let report = try! JSONDecoder().decode(UsageReport.self, from: Data(#"{"range":"today","summary":{"requests":2,"totalTokens":3,"estimatedCostUsd":4}}"#.utf8))
            var snapshot = ProxySnapshot(endpoint: .default, usage: report, today: report, timeline: timeline)
            snapshot.state = .running(try! JSONDecoder().decode(StartupHealth.self, from: Data(#"{"status":"protected"}"#.utf8)))
            let widget = WidgetSnapshot.make(from: snapshot, now: Date(timeIntervalSince1970: 100))
            t.equal(widget.schemaVersion, 1)
            t.equal(widget.today?.requests, 2)
            t.equal(widget.chart?.series.count, 6)
        }
        t.test("widget snapshot: encoded payload contains no credentials") {
            let snapshot = WidgetSnapshot.make(from: ProxySnapshot(endpoint: .default), now: Date())
            let data = try! JSONEncoder().encode(snapshot)
            let text = String(decoding: data, as: UTF8.self)
            t.expect(!text.contains("apiKey") && !text.contains("x-opencodex"), "privacy")
        }
        t.test("widget snapshot: store writes to injected home") {
            let home = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            let store = WidgetSnapshotStore(homeDirectory: home)
            let snapshot = WidgetSnapshot.make(from: ProxySnapshot(endpoint: .default), now: Date())
            store.writeIfChanged(snapshot)
            t.expect(FileManager.default.fileExists(atPath: store.url.path), "snapshot file")
            let mode = (try? FileManager.default.attributesOfItem(atPath: store.url.path)[.posixPermissions] as? NSNumber)?.intValue
            t.equal(mode, 0o600)
        }
    }
}
