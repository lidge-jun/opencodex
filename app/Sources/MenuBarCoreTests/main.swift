import Foundation

// Entry point for `swift run --package-path app MenuBarCoreTests`.
// See Harness.swift for why this is an executable rather than an XCTest bundle.

let runner = TestRunner()

DiscoverySuite.run(runner)
ModelDecodingSuite.run(runner)
FormattingSuite.run(runner)
CompanionSettingsSuite.run(runner)
TimelineDecodingSuite.run(runner)
MenuBarTitleSuite.run(runner)
WidgetSnapshotSuite.run(runner)
TransportSuite.run(runner)
SnapshotStateSuite.run(runner)
PollingSuite.run(runner)
ActionSuite.run(runner)

exit(runner.summarize())
