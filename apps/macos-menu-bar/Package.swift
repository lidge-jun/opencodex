// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "OpenCodexMenuBar",
    platforms: [
        .macOS(.v12),
    ],
    products: [
        .executable(name: "OpenCodexMenuBar", targets: ["OpenCodexMenuBar"]),
    ],
    targets: [
        .target(
            name: "OpenCodexMenuBarCore",
            path: "Sources/OpenCodexMenuBarCore"
        ),
        .executableTarget(
            name: "OpenCodexMenuBar",
            dependencies: ["OpenCodexMenuBarCore"],
            path: "Sources/OpenCodexMenuBar"
        ),
        .testTarget(
            name: "OpenCodexMenuBarCoreTests",
            dependencies: ["OpenCodexMenuBarCore"],
            path: "Tests/OpenCodexMenuBarCoreTests"
        ),
    ],
    swiftLanguageVersions: [.v5]
)
