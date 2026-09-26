import Foundation
import NativeTray

var assertions = 0
func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    assertions += 1
    if !condition() { fatalError(message) }
}

let settings: [String: Any] = [
    "showToday": true, "show30Days": true, "showChart": true,
    "showModels": true, "showAccounts": true, "showCost": true, "chartStyle": "line",
]
func decode(_ changes: [String: Any] = [:]) throws -> NativeTraySnapshot {
    var value: [String: Any] = [
        "schemaVersion": 1, "refreshing": false, "errors": [], "settings": settings,
        "models": [], "providers": [],
    ]
    value.merge(changes) { _, new in new }
    return try NativeTraySnapshot.decode(JSONSerialization.data(withJSONObject: value))
}

let empty = try decode()
check(empty.today == nil && empty.month == nil, "Missing totals must remain unknown")
check(NativeTrayFormat.tokens(nil) == "—", "Missing must not render zero")
check(NativeTrayFormat.tokens(0) == "0", "Measured zero must render zero")
check(NativeTrayFormat.tokens(10_000_000) == "10M", "Whole-number trailing zeros must survive")
check(NativeTrayFormat.number(-1) == nil, "Negative measurements rejected")
check(NativeTrayFormat.number(.infinity) == nil, "Infinite measurements rejected")
check(NativeTrayFormat.number(.nan) == nil, "NaN measurements rejected")

let unmeasured = try decode(["today": [
    "requests": 3, "measuredRequests": 0, "pricedRequests": 0,
    "totalTokens": 0, "inputTokens": 0, "outputTokens": 0, "estimatedCostUsd": 0,
]])
check(unmeasured.today?.tokens == nil, "Unmeasured nonempty requests are not zero tokens")
check(unmeasured.today?.input == nil && unmeasured.today?.output == nil, "Unmeasured input/output stay unknown")
check(unmeasured.today?.cost == nil, "Unpriced nonempty requests are not free")
check(unmeasured.today?.coverage == 0, "Coverage remains an honest zero")
check(unmeasured.today?.costIncomplete == true, "Unpriced requests carry partial-cost disclosure")
let measured = try decode(["today": [
    "requests": 4, "measuredRequests": 3, "pricedRequests": 4,
    "totalTokens": 120, "inputTokens": 100, "outputTokens": 20,
    "cachedInputTokens": 75, "estimatedCostUsd": 0,
]])
check(measured.today?.tokens == 120 && measured.today?.cost == 0, "Measured/free data retained")
check(measured.today?.coverage == 75 && measured.today?.cachedPercent == 75, "Coverage and cache ratio calculated")

let account: [String: Any] = ["id": "account-a", "label": "한글 계정", "active": true,
    "unavailable": false, "windows": [["id": "weekly", "label": "Weekly", "percent": 125, "resetAt": 1_900_000_000_000]]]
let quotasOnly = try decode(["errors": ["Usage unavailable"], "providers": [
    ["id": "provider-a", "label": "Provider A", "unavailable": false, "accounts": [account]],
]])
let window = quotasOnly.providers[0].accounts[0].windows[0]
check(quotasOnly.today == nil && quotasOnly.providers.count == 1, "Usage failure cannot hide successful quotas")
check(quotasOnly.providers[0].accounts[0].label == "한글 계정", "Unicode label survives the wire")
check(window.value == 125 && window.fill == 1, "Clamp fill, preserve displayed over-limit percent")
check(window.resetDate == Date(timeIntervalSince1970: 1_900_000_000), "Millisecond reset normalized")
check(NativeTrayFormat.date(1_900_000_000) == window.resetDate, "Second and millisecond reset agree")
check(NativeTrayFormat.date(0) == nil && NativeTrayFormat.date(1e300) == nil, "Invalid reset times are unavailable")
let now = Date(timeIntervalSince1970: 1_900_000_000)
check(NativeTrayFormat.reset(1_900_000_061, now: now) == "2m", "Reset duration rounds up")
check(NativeTrayFormat.reset(1_899_999_999, now: now) == "—", "Expired reset is not a future promise")

do { _ = try decode(["schemaVersion": 2]); fatalError("Unknown schema was accepted") }
catch NativeTrayDecodeError.unsupportedSchema { assertions += 1 }
do { _ = try decode(["providers": "bad"]); fatalError("Malformed roster was accepted") }
catch is DecodingError { assertions += 1 }

let many = try decode(["providers": (0..<80).map { index in
    ["id": "provider-\(index)", "label": "Provider \(index)", "unavailable": false, "accounts": [account]] as [String: Any]
}])
check(many.providers.count == 80, "Long roster must not be truncated to fit the popup")
check(Set(many.providers.map(\.id)).count == 80, "Provider identities disambiguate equal account ids")

// Provider marks: one representative file per paint mode, decoded by the view's own decoder.
let icons = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().appendingPathComponent("gui/public/provider-icons")
for file in ["openai.svg", "grok.svg", "zai.svg", "nebius.svg"] {
    let svg = try String(contentsOf: icons.appendingPathComponent(file), encoding: .utf8)
    let image = NativeTrayIcon.image(svg: svg)
    check(image != nil && image!.size.width > 0 && image!.size.height > 0, "\(file) must decode to a visible mark")
}
check(NativeTrayIcon.image(svg: "not an image") == nil, "Unreadable mark data is no mark")
let marked = try decode(["providers": [["id": "openai", "label": "OpenAI", "unavailable": false, "accounts": [],
    "iconSvg": "<svg/>", "iconPaint": "mask"]]])
check(marked.providers[0].iconPaint == "mask" && marked.providers[0].iconSvg == "<svg/>", "Mark fields decode")
check(quotasOnly.providers[0].iconSvg == nil, "Providers without a mark still decode")

// Quota bars use the dashboard's severity thresholds and keep a spoken value.
check(NativeTrayFormat.severity(69.9) == .normal && NativeTrayFormat.severity(70) == .warn, "Warn at 70%")
check(NativeTrayFormat.severity(90) == .critical && NativeTrayFormat.severity(125) == .critical, "Critical at 90%")
check(NativeTrayFormat.severity(nil) == .normal, "Unknown is not a severity")
check(NativeTrayFormat.percentDescription(125) == "125 percent", "Over-limit value is spoken as reported")
check(NativeTrayFormat.percentDescription(nil) == "Unavailable", "Missing value is spoken as unavailable")
// Labels floor like the dashboard so the number never crosses a threshold the color has not.
check(NativeTrayFormat.percentText(69.9) == "69%" && NativeTrayFormat.severity(69.9) == .normal, "69.9% reads 69% on green")
check(NativeTrayFormat.percentText(89.9) == "89%" && NativeTrayFormat.severity(89.9) == .warn, "89.9% reads 89% on orange")
check(NativeTrayFormat.percentDescription(89.9) == "89 percent", "Spoken value floors too")
check(NativeTrayFormat.percentText(nil) == "—", "Missing value renders a dash")
print("PASS: \(assertions) native tray contract/formatting assertions")
