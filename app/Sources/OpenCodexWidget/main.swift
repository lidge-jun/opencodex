import WidgetKit

// This call is the widget. Without it the extension still launches and still registers with
// pluginkit — the Info.plist alone is enough for that — but no WidgetBundle is ever handed to the
// extension host, so the gallery has no configuration to offer and the widget silently does not
// appear. That is what shipped: the executable carried SnapshotProvider and the views, and the
// linker had been pointed straight at _NSExtensionMain, which looks for an
// NSExtensionPrincipalClass this bundle does not declare.
//
// Xcode spells this `@main` on the WidgetBundle. SwiftPM cannot: `@main` and a main.swift in the
// same target are mutually exclusive, and the target needs main.swift to be an executable here.
// `WidgetBundle.main()` is the same entry `@main` expands to.
if #available(macOS 14, *) {
    OpenCodexWidgetBundle.main()
}
