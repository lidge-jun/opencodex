// Renders every menu bar glyph state to one sheet so the state signal can be verified
// visually. The notch previously did not render at all, which made protected and
// at-risk indistinguishable.
import AppKit
import MenuBarCore
import MenuBarUI

let states: [(String, ProxyState)] = [
    ("protected", .running(StartupHealth(status: "protected"))),
    ("at-risk", .running(StartupHealth(status: "at-risk"))),
    ("loading", .loading),
    ("stopped", .unreachable),
]

let scale: CGFloat = 6
let cell = NSSize(width: 17 * scale, height: 17 * scale)
let sheet = NSImage(size: NSSize(width: cell.width * CGFloat(states.count), height: cell.height))
sheet.lockFocus()
NSColor.white.setFill()
NSRect(origin: .zero, size: sheet.size).fill()
for (i, entry) in states.enumerated() {
    let img = StatusIcon.image(for: entry.1)
    let rect = NSRect(x: CGFloat(i) * cell.width, y: 0, width: cell.width, height: cell.height)
    NSGraphicsContext.current?.imageInterpolation = .none
    img.draw(in: rect.insetBy(dx: 8, dy: 8))
}
sheet.unlockFocus()
if let tiff = sheet.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
   let png = rep.representation(using: .png, properties: [:]) {
    try? png.write(to: URL(fileURLWithPath: "/tmp/glyphs.png"))
}
print("wrote /tmp/glyphs.png:", states.map(\.0).joined(separator: ", "))
