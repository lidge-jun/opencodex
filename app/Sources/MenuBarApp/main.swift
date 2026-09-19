import AppKit
import MenuBarUI

let app = NSApplication.shared
// .accessory keeps it out of the Dock; LSUIElement in Info.plist does the same for the
// packaged bundle, and this covers `swift run` during development.
app.setActivationPolicy(.accessory)

let delegate = AppDelegate()
app.delegate = delegate
app.run()
