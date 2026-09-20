// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "OpenCodexWidget",
    platforms: [.macOS(.v14)],
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
            swiftSettings: [
                // Xcode sets APPLICATION_EXTENSION_API_ONLY on an app-extension target, and the
                // two projects that have this working from SwiftPM pass its compiler spelling by
                // hand. It restricts the target to the extension-safe API surface, which is the
                // contract the extension host assumes it was built against.
                .unsafeFlags(["-application-extension"]),
            ],
            linkerSettings: [
                // A widget extension needs both halves of what Xcode does for an app-extension
                // target, and each half is useless alone. This flag is one of them; `@main` on
                // OpenCodexWidgetBundle is the other.
                //
                // With the entry override and no `@main`, nothing references the WidgetBundle, the
                // linker drops it, and the extension registers with pluginkit — the Info.plist is
                // enough for that — while the gallery has no configuration to offer. That is what
                // shipped, and it failed silently.
                //
                // With `@main` and no entry override, the Swift main runs instead of
                // NSExtensionMain, and ExtensionFoundation traps inside
                // _EXRunningExtension._shared while bootstrapping. Measured: EXC_BREAKPOINT on
                // every launch, chronod logging "query failed - will try lazy reload later", and
                // a crash report per attempt.
                //
                // Both together is the shape that works and the shape Xcode produces: the entry
                // is NSExtensionMain, and the bundle stays in the binary because `@main` refers
                // to it.
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
