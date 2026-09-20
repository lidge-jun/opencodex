// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "OpenCodexWidget",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "OpenCodexWidget", targets: ["OpenCodexWidget"]),
        .executable(name: "MenuBarCoreTests", targets: ["MenuBarCoreTests"]),
    ],
    targets: [
        .target(name: "MenuBarCore", path: "Sources/MenuBarCore"),
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
    ],
    swiftLanguageVersions: [.v5]
)
