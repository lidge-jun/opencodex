import Foundation
import MenuBarCore

/// Magnitudes are taken from the live proxy capture in 002_api_surface.md.
enum FormattingSuite {
    static func run(_ t: TestRunner) {
        t.test("format: counts group below 10k and suffix above") {
            t.equal(Format.count(0), "0")
            t.equal(Format.count(1_746), "1,746")
            t.equal(Format.count(9_999), "9,999")
            t.equal(Format.count(232_507), "233K")
            t.equal(Format.count(1_200_000), "1.20M")
        }

        // Rounding can push a value across its own unit boundary: 999_999 scales to
        // 999.999K and must promote to 1.00M rather than render "1000K".
        t.test("format: values promote at suffix rollover boundaries") {
            t.equal(Format.count(999_999), "1.00M")
            t.equal(Format.count(999_499), "999K")
            t.equal(Format.tokens(999_999_999), "1.00B")
            t.equal(Format.tokens(999_999_999_999), "1.00T")
            t.equal(Format.cost(999_999), "$1.00M")
        }

        t.test("format: exact unit thresholds render as the new unit") {
            t.equal(Format.tokens(1_000), "1.00K")
            t.equal(Format.tokens(1_000_000), "1.00M")
            t.equal(Format.tokens(1_000_000_000), "1.00B")
        }

        t.test("format: tokens are suffixed at scale") {
            t.equal(Format.tokens(999), "999")
            t.equal(Format.tokens(12_400_000), "12.4M")
            t.equal(Format.tokens(36_536_664_705), "36.5B")
        }

        t.test("format: cost switches to a suffix above one thousand") {
            t.equal(Format.cost(8.21), "$8.21")
            t.equal(Format.cost(999.99), "$999.99")
            t.equal(Format.cost(34_018.25204647066), "$34.0K")
        }

        // Unknown and zero are different facts. Rendering nil as "0" is the fake-data
        // tell that 003 section 6 bans.
        t.test("format: nil renders an em dash while zero renders zero") {
            t.equal(Format.count(nil), "—")
            t.equal(Format.tokens(nil), "—")
            t.equal(Format.cost(nil), "—")
            t.equal(Format.percent(nil), "—")
            t.equal(Format.count(0), "0")
            t.equal(Format.cost(0), "$0.00")
        }

        t.test("format: percent rounds") {
            t.equal(Format.percent(44), "44%")
            t.equal(Format.percent(86.82666666666667), "87%")
            t.equal(Format.percent(9.976811594202898), "10%")
        }

        t.test("format: reset countdowns are coarse") {
            let now = Date(timeIntervalSince1970: 1_784_915_000)
            t.equal(Format.resetsIn(now.addingTimeInterval(60 * 30), now: now), "30m")
            t.equal(Format.resetsIn(now.addingTimeInterval(3600 * 5), now: now), "5h")
            t.equal(Format.resetsIn(now.addingTimeInterval(86_400 * 3 + 3600 * 4), now: now), "3d 4h")
            t.equal(Format.resetsIn(now.addingTimeInterval(-60), now: now), "expired")
            t.equal(Format.resetsIn(nil), "—")
        }

        t.test("format: staleness ages read naturally") {
            let now = Date(timeIntervalSince1970: 1_784_915_000)
            t.equal(Format.age(now.addingTimeInterval(-10), now: now), "just now")
            t.equal(Format.age(now.addingTimeInterval(-120), now: now), "2m ago")
            t.equal(Format.age(now.addingTimeInterval(-7200), now: now), "2h ago")
            t.equal(Format.age(nil), "—")
        }
    }
}
