import AppKit
import MenuBarCore
import MenuBarUI

// UI-layer tests. Separate from MenuBarCoreTests because these need AppKit and an
// NSApplication; the core suite deliberately has no UI dependency.
//
// These cover the Phase 3 behaviours that were defects in earlier review rounds:
// optimistic rollback, pending state surviving a poll, and the direction-sensitive
// default-provider guard.

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

let runner = TestRunner()

func provider(_ name: String, enabled: Bool = true) -> ProviderSummary {
    let json = #"{"name":"\#(name)","disabled":\#(enabled ? "false" : "true")}"#
    return try! JSONDecoder().decode(ProviderSummary.self, from: Data(json.utf8))
}

func snapshot(
    providers: [ProviderSummary],
    defaultProvider: String? = "openai"
) -> ProxySnapshot {
    ProxySnapshot(
        state: .running(StartupHealth(status: "protected")),
        endpoint: .default,
        providers: providers,
        defaultProvider: defaultProvider,
        lastUpdated: Date(),
        providersLoaded: true
    )
}

// MARK: - Default-provider guard direction

runner.test("ui: an enabled default provider cannot be switched off") {
    let list = ProviderListView()
    list.apply(snapshot(providers: [provider("openai"), provider("anthropic")]))
    list.expandForTesting()

    runner.equal(list.isToggleEnabled("openai"), false, "enabled default is inert")
    runner.equal(list.isToggleEnabled("anthropic"), true, "non-default is toggleable")
}

// The proxy guard is `disabled && name === defaultProvider`, so ENABLING the default is
// valid. Making the control inert whenever isDefault stranded the user.
runner.test("ui: a disabled default provider can still be switched back on") {
    let list = ProviderListView()
    list.apply(snapshot(providers: [provider("openai", enabled: false)]))
    list.expandForTesting()

    runner.equal(list.isToggleEnabled("openai"), true, "disabled default must be recoverable")
}

// MARK: - Optimistic update and rollback

runner.test("ui: a rejected write restores the switch it moved") {
    let list = ProviderListView()
    list.apply(snapshot(providers: [provider("anthropic")]))
    list.expandForTesting()

    // User switches it off; the write is in flight.
    list.setBusy("anthropic", true, intended: false)
    runner.equal(list.isToggleOn("anthropic"), false, "optimistic state applied")
    runner.equal(list.isToggleEnabled("anthropic"), false, "inert while in flight")

    // The proxy rejects it.
    list.revert("anthropic", to: true)
    runner.equal(list.isToggleOn("anthropic"), true, "reverted to the server's value")
    runner.equal(list.isToggleEnabled("anthropic"), true, "interactive again")
}

runner.test("ui: a successful write clears busy without reverting") {
    let list = ProviderListView()
    list.apply(snapshot(providers: [provider("anthropic")]))
    list.expandForTesting()

    list.setBusy("anthropic", true, intended: false)
    // The authoritative refresh now reports it disabled.
    list.apply(snapshot(providers: [provider("anthropic", enabled: false)]))
    list.setBusy("anthropic", false)

    runner.equal(list.isToggleOn("anthropic"), false, "server state retained")
    runner.equal(list.isToggleEnabled("anthropic"), true, "interactive again")
}

// MARK: - Pending state versus a stale poll

// This is the defect a reviewer caught: rebuildRows initialised each switch from the
// snapshot, so a poll carrying pre-write data snapped the switch back mid-write.
runner.test("ui: a stale poll cannot undo an in-flight optimistic change") {
    let list = ProviderListView()
    list.apply(snapshot(providers: [provider("anthropic")]))
    list.expandForTesting()

    list.setBusy("anthropic", true, intended: false)
    runner.equal(list.isToggleOn("anthropic"), false, "optimistic state applied")

    // A poll that started before the write lands, still reporting the old value.
    list.apply(snapshot(providers: [provider("anthropic", enabled: true)]))

    runner.equal(list.isToggleOn("anthropic"), false, "stale poll must not snap it back")
    runner.equal(list.isToggleEnabled("anthropic"), false, "still inert while in flight")
}

runner.test("ui: pending state is per provider and does not leak") {
    let list = ProviderListView()
    list.apply(snapshot(providers: [provider("anthropic"), provider("xai")]))
    list.expandForTesting()

    list.setBusy("anthropic", true, intended: false)
    runner.equal(list.isToggleEnabled("anthropic"), false, "target is inert")
    runner.equal(list.isToggleEnabled("xai"), true, "sibling is unaffected")
    runner.equal(list.isToggleOn("xai"), true, "sibling keeps its value")
}

// MARK: - Empty and unloaded states

runner.test("ui: providers are hidden until they have actually been read") {
    let list = ProviderListView()
    var unloaded = snapshot(providers: [])
    unloaded.providersLoaded = false
    list.apply(unloaded)
    runner.equal(list.isHidden, true, "not fetched yet is not the same as none")

    list.apply(snapshot(providers: []))
    runner.equal(list.isHidden, false, "an empty result renders its own copy")
}

runner.test("ui: hidden providers do not create rows") {
    let list = ProviderListView()
    var current = snapshot(providers: [provider("openai"), provider("anthropic")])
    current.settings = CompanionSettings(hiddenProviders: ["openai"])
    list.apply(current)
    list.expandForTesting()
    runner.equal(list.hasProviderForTesting("openai"), false)
    runner.equal(list.hasProviderForTesting("anthropic"), true)
}

runner.test("ui: chart setting hides the timeline view") {
    let chart = TimelineChartView()
    var current = snapshot(providers: [])
    current.timeline = try! JSONDecoder().decode(
        UsageTimeline.self,
        from: Data(#"{"start":0,"end":1,"bucketSeconds":1,"buckets":1,"metric":"total","aggregation":"sum","grouping":"model","series":[],"availableModels":[],"missingMeasurements":0}"#.utf8)
    )
    current.settings = CompanionSettings(showChart: false)
    chart.apply(current)
    runner.equal(chart.isHidden, true)
}

runner.test("ui: menu title renders from a companion template") {
    let report = try! JSONDecoder().decode(
        UsageReport.self,
        from: Data(#"{"range":"today","summary":{"requests":3}}"#.utf8)
    )
    var current = snapshot(providers: [])
    current.today = report
    current.settings = CompanionSettings(menuBarTemplate: "req {requests}")
    runner.equal(current.menuBarTitle, "req 3")
}

exit(runner.summarize())
