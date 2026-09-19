// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "OpenCodexMenuBar",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "OpenCodexMenuBar", targets: ["MenuBarApp"]),
        .executable(name: "OpenCodexWidget", targets: ["OpenCodexWidget"]),
        .executable(name: "MenuBarCoreTests", targets: ["MenuBarCoreTests"]),
        .executable(name: "MenuBarUITests", targets: ["MenuBarUITests"]),
        .executable(name: "UIProbe", targets: ["UIProbe"]),
        .executable(name: "IconProbe", targets: ["IconProbe"]),
    ],
    targets: [
        .target(name: "MenuBarCore", path: "Sources/MenuBarCore"),
        // AppKit views live in a library so both the app and the visual-QA probe can
        // build the same surface. An executable target cannot be imported.
        .target(name: "MenuBarUI", dependencies: ["MenuBarCore"], path: "Sources/MenuBarUI"),
        .executableTarget(
            name: "MenuBarApp",
            dependencies: ["MenuBarCore", "MenuBarUI"],
            path: "Sources/MenuBarApp"
        ),
        .executableTarget(
            name: "OpenCodexWidget",
            dependencies: ["MenuBarCore"],
            path: "Sources/OpenCodexWidget",
            linkerSettings: [
                // Widget extensions must enter through NSExtensionMain or chronod tears down
                // the process before the WidgetBundle connects.
                .linkedFramework("Foundation"),
                .unsafeFlags(["-Xlinker", "-e", "-Xlinker", "_NSExtensionMain"]),
            ]
        ),
        // An executable rather than a .testTarget: Xcode Command Line Tools ships
        // neither a usable XCTest module nor the swift-testing runtime, so a test bundle
        // cannot run without a full Xcode install. See Sources/MenuBarCoreTests/Harness.swift.
        .executableTarget(
            name: "MenuBarCoreTests",
            dependencies: ["MenuBarCore"],
            path: "Sources/MenuBarCoreTests"
        ),
        // UI-layer tests need AppKit and an NSApplication, so they are a separate
        // executable from the dependency-free core suite.
        .executableTarget(
            name: "MenuBarUITests",
            dependencies: ["MenuBarCore", "MenuBarUI"],
            path: "Sources/MenuBarUITests"
        ),
        .executableTarget(name: "UIProbe", dependencies: ["MenuBarCore", "MenuBarUI"], path: "Sources/UIProbe"),
        .executableTarget(name: "IconProbe", dependencies: ["MenuBarCore", "MenuBarUI"], path: "Sources/IconProbe"),
    ],
    swiftLanguageVersions: [.v5]
)
