import Foundation
import MenuBarCore

enum MenuBarTitleSuite {
    private static let reportJSON = #"{"range":"today","summary":{"requests":12,"totalTokens":3456,"inputTokens":1000,"outputTokens":2000,"estimatedCostUsd":1.25}}"#

    static func run(_ t: TestRunner) {
        let report = try! JSONDecoder().decode(UsageReport.self, from: Data(reportJSON.utf8))
        for metric in [CompanionSettings.MenuBarMetric.requests, .tokens, .cost] {
            t.test("menu title: \(metric.rawValue) metric") {
                let settings = CompanionSettings(menuBarMetric: metric)
                t.expect(MenuBarTitle.render(settings: settings, today: report, quotas: []) != nil, "title")
            }
        }
        t.test("menu title: quota picks the lowest percent") {
            let settings = CompanionSettings(menuBarMetric: .quota)
            let quotas = try! JSONDecoder().decode([QuotaReport].self, from: Data(#"[{"provider":"a","quota":{"weeklyPercent":80}},{"provider":"b","quota":{"weeklyPercent":20}}]"#.utf8)).map { $0.normalized() }
            t.equal(MenuBarTitle.render(settings: settings, today: report, quotas: quotas), "20%")
        }
        t.test("menu title: template replaces placeholders") {
            let settings = CompanionSettings(menuBarTemplate: "{requests}/{totalTokens}/{costUsd}")
            t.equal(MenuBarTitle.render(settings: settings, today: report, quotas: []), "12/3.46K/$1.25")
        }
        t.test("menu title: none is nil and unknowns are em dashes") {
            t.isNil(MenuBarTitle.render(settings: CompanionSettings(menuBarMetric: .none), today: report, quotas: []), "none")
            let settings = CompanionSettings(menuBarTemplate: "{inputTokens}")
            t.equal(MenuBarTitle.render(settings: settings, today: nil, quotas: []), "—")
        }
        t.test("menu title: long output is truncated") {
            let settings = CompanionSettings(menuBarTemplate: "012345678901234567890123456789")
            let title = MenuBarTitle.render(settings: settings, today: report, quotas: [])
            t.equal(title?.count, 24)
            t.expect(title?.hasSuffix("…") == true, "ellipsis")
        }
    }
}
