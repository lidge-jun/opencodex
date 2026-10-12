import Foundation
import MenuBarCore

enum WidgetSnapshotSuite {
    static func run(_ t: TestRunner) {
        t.test("widget: a snapshot turns stale two heartbeats after it was written") {
            let written = WidgetSnapshot(
                schemaVersion: 1, generatedAt: 1_000, state: "running", stateTitle: "Running", detail: nil,
                endpointDisplay: "127.0.0.1:10100", menuTitle: nil, today: nil, quotas: [], chart: nil, lastUpdated: 1_000)
            t.equal(WidgetSnapshot.staleAfter, 1_800)
            t.equal(written.staleDate, Date(timeIntervalSince1970: 2_800))
            t.expect(!written.isStale(now: Date(timeIntervalSince1970: 2_799)), "fresh one second before the boundary")
            t.expect(written.isStale(now: Date(timeIntervalSince1970: 2_800)), "stale at the boundary")
        }
        t.test("widget: hidden usage and quota respect the same projection as the menu title") {
            let report = try! JSONDecoder().decode(UsageReport.self, from: Data(#"{"summary":{"requests":99,"totalTokens":99},"models":[{"provider":"hidden","model":"m","requests":97,"totalTokens":94},{"provider":"visible","model":"m","requests":2,"totalTokens":5,"estimatedCostUsd":0.25}]}"#.utf8))
            let quotas = try! JSONDecoder().decode([QuotaReport].self, from: Data(#"[{"provider":"hidden","quota":{"weeklyPercent":1}},{"provider":"visible","quota":{"weeklyPercent":75}}]"#.utf8))
            let settings = CompanionSettings(menuBarMetric: .requests, hiddenProviders: ["hidden"])
            let snapshot = ProxySnapshot(endpoint: .default, settings: settings, today: report, quotas: quotas)
            let widget = WidgetSnapshot.make(from: snapshot)
            t.equal(widget.today?.requests, 2)
            t.equal(widget.today?.totalTokens, 5)
            t.equal(widget.today?.estimatedCostUsd, 0.25)
            t.equal(widget.menuTitle, "2")
            t.equal(widget.quotas.count, 1)
            t.equal(widget.quotas.first?.percent, 75)
            let folded = try! JSONDecoder().decode(UsageReport.self, from: Data(#"{"summary":{"requests":99},"models":[{"provider":"other","model":"other","requests":99}]}"#.utf8))
            t.expect(folded.filteredSummary(settings) == nil, "folded attribution is unknown")
            t.equal(MenuBarTitle.render(settings: settings, today: folded, quotas: []), "—")
            let plain = try! JSONDecoder().decode(UsageReport.self, from: Data(#"{"summary":{"requests":0}}"#.utf8))
            t.equal(plain.filteredSummary(.defaults)?.requests, 0)
        }
        t.test("timeline: only matching filter echoes preserve folded data") {
            let base: [String: Any] = ["start": 0, "end": 60, "bucketSeconds": 60, "buckets": 1,
                "metric": "total", "aggregation": "sum", "grouping": "model", "availableModels": ["visible/m", "hidden/m"], "missingMeasurements": 0,
                "series": [["id":"visible/m","provider":"visible","model":"m","total":2,"points":[2]],
                           ["id":"hidden/m","provider":"hidden","model":"m","total":1,"points":[1]],
                           ["id":"other","provider":"","model":"other","total":3,"points":[3]]]]
            func timeline(_ echo: Any? = nil) -> UsageTimeline {
                var value = base
                if let echo { value["appliedFilters"] = echo }
                return try! JSONDecoder().decode(UsageTimeline.self, from: JSONSerialization.data(withJSONObject: value))
            }
            let settings = CompanionSettings(hiddenProviders: ["hidden"])
            let matching = timeline(["models": NSNull(), "hiddenProviders": ["hidden"]]).projected(settings)
            t.equal(matching.series.map(\.id), ["visible/m", "other"])
            t.expect(matching.truncated != true, "matching receipt is complete")
            let old = timeline().projected(settings)
            t.equal(old.series.map(\.id), ["visible/m"])
            t.equal(old.truncated, true)
            let mismatched = timeline(["models": NSNull(), "hiddenProviders": []]).projected(settings)
            t.equal(mismatched.truncated, true)
            let malformed: [Any] = [
                ["hiddenProviders": ["hidden"]],
                ["models": NSNull()],
                ["models": "wrong", "hiddenProviders": ["hidden"]],
                ["models": NSNull(), "hiddenProviders": Array(repeating: "hidden", count: 101)],
                ["models": Array(repeating: "visible/m", count: 101), "hiddenProviders": []],
                ["models": NSNull(), "hiddenProviders": [1]],
                "wrong", NSNull(),
            ]
            for receipt in malformed {
                let decoded = timeline(receipt)
                t.expect(decoded.appliedFilters == nil, "malformed optional receipt is ignored")
                t.equal(decoded.projected(settings).series.map(\.id), ["visible/m"])
                t.equal(decoded.projected(settings).truncated, true)
                t.equal(decoded.projected(.defaults).series.count, 3)
            }
            let selected = CompanionSettings(models: ["visible/m"])
            t.equal(timeline(["models": ["visible/m"], "hiddenProviders": []]).projected(selected).series.map(\.id), ["visible/m", "other"])
            let empty = timeline().projected(CompanionSettings(models: []))
            t.expect(empty.series.isEmpty, "explicit empty selection")
            t.equal(empty.availableModels, ["visible/m", "hidden/m"])
            t.expect(empty.truncated != true, "empty selection is not a read failure")
            t.equal(timeline().projected(.defaults).series.count, 3)
            let widget = WidgetSnapshot.make(from: ProxySnapshot(endpoint: .default, settings: settings, timeline: old))
            t.equal(widget.chart?.incomplete, true)
        }
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
