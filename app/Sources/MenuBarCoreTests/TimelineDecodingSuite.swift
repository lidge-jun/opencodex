import Foundation
import MenuBarCore

enum TimelineDecodingSuite {
    static func run(_ t: TestRunner) {
        t.test("timeline: decodes series and derived maxima") {
            let json = #"{"start":0,"end":3600,"bucketSeconds":1800,"buckets":2,"metric":"total","aggregation":"sum","grouping":"model","series":[{"id":"a","provider":"p","model":"m","total":3,"points":[1,2]},{"id":"b","provider":"p","model":"n","total":4,"points":[4,0]}],"availableModels":["p/m","p/n"],"missingMeasurements":1,"truncated":true}"#
            let timeline = try JSONDecoder().decode(UsageTimeline.self, from: Data(json.utf8))
            t.equal(timeline.maxPoint, 4)
            t.equal(timeline.stackedMax, 5)
            t.equal(timeline.isEmpty, false)
            t.equal(timeline.truncated, true)
        }
    }
}
