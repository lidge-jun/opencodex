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
                // The entry stays the Swift one so main.swift runs and calls
                // OpenCodexWidgetBundle.main(); that call is what connects the bundle to the
                // extension host. Forcing the entry to _NSExtensionMain instead skips it, and
                // NSExtensionMain then looks for an NSExtensionPrincipalClass a SwiftUI widget
                // does not declare, so the extension registers and offers nothing.
                .linkedFramework("Foundation"),
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
