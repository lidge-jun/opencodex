import Foundation
import MenuBarCore

enum CompanionSettingsSuite {
    static func run(_ t: TestRunner) {
        let decoder = JSONDecoder()
        t.test("companion settings: empty JSON uses defaults") {
            let settings = try decoder.decode(CompanionSettings.self, from: Data("{}".utf8))
            t.equal(settings, .defaults)
        }
        t.test("companion settings: unknown enum uses its default") {
            let settings = try decoder.decode(CompanionSettings.self, from: Data(#"{"menuBarMetric":"future","chartStyle":"future","tokenMetric":"future","aggregation":"future","chartGrouping":"future"}"#.utf8))
            t.equal(settings.menuBarMetric, .tokens)
            t.equal(settings.chartStyle, .line)
            t.equal(settings.tokenMetric, .total)
            t.equal(settings.aggregation, .sum)
            t.equal(settings.chartGrouping, .model)
        }
        t.test("companion settings: full payload decodes") {
            let settings = try decoder.decode(CompanionSettings.self, from: Data(#"{"menuBarMetric":"quota","menuBarTemplate":"{requests}","showToday":false,"showChart":false,"showModels":false,"showCost":false,"showAccounts":false,"chartHours":72,"bucketMinutes":180,"chartStyle":"stackedBar","tokenMetric":"cached","aggregation":"max","chartGrouping":"modelAccount","models":["openai/gpt"],"hiddenProviders":["openai"]}"#.utf8))
            t.equal(settings.chartHours, 72)
            t.equal(settings.chartStyle, .stackedBar)
            t.equal(settings.models, ["openai/gpt"])
            t.equal(settings.hiddenProviders, ["openai"])
        }
    }
}
