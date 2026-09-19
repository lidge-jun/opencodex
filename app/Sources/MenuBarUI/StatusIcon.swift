import AppKit
import MenuBarCore

/// The menu bar glyph.
///
/// Drawn as vector paths rather than shipped as PNGs, so it stays crisp at every scale
/// factor and inverts correctly as a template image.
///
/// Colour is deliberately absent here. macOS menu bar items are monochrome by
/// convention, and a coloured dot up there is the tell of an app that does not respect
/// the platform. State is carried by fill and by a notch instead. The coloured dot lives
/// inside the popover, where it sits beside a word and so never encodes meaning by
/// colour alone.
public enum StatusIcon {
    public static let size = NSSize(width: 17, height: 17)

    public static func image(for state: ProxyState) -> NSImage {
        switch state {
        case .running(let health) where health.isProtected:
            return mark(filled: true, notched: false, alpha: 1)
        case .running:
            return mark(filled: true, notched: true, alpha: 1)
        case .loading, .degraded:
            return mark(filled: false, notched: false, alpha: 1)
        case .unreachable, .unauthorized:
            return mark(filled: false, notched: false, alpha: 0.4)
        }
    }

    /// A rounded mark reduced to menu bar scale.
    ///
    /// The notch is carved out of the geometry with an even-odd path rather than by
    /// compositing. An earlier version stroked with `.clear` and `.clear` composite mode,
    /// which silently did nothing — the rendered at-risk glyph was indistinguishable from
    /// the protected one, so the state signal was invisible.
    private static func mark(filled: Bool, notched: Bool, alpha: CGFloat) -> NSImage {
        let image = NSImage(size: size, flipped: false) { rect in
            let inset = rect.insetBy(dx: 2.5, dy: 2.5)
            let path = NSBezierPath(roundedRect: inset, xRadius: 4, yRadius: 4)

            if notched {
                // A slot carved out of the trailing edge, kept fully inside the mark so
                // the silhouette stays clean. Even-odd winding turns the subpath into a
                // hole rather than a second filled shape.
                let notch = NSBezierPath(
                    roundedRect: NSRect(
                        x: inset.maxX - 4.2,
                        y: inset.midY - 1.1,
                        width: 3.0,
                        height: 2.2
                    ),
                    xRadius: 1.1,
                    yRadius: 1.1
                )
                path.append(notch)
                path.windingRule = .evenOdd
            }

            NSColor.black.withAlphaComponent(alpha).setStroke()
            NSColor.black.withAlphaComponent(alpha).setFill()

            if filled {
                path.fill()
            } else {
                path.lineWidth = 1.6
                path.stroke()
            }
            return true
        }
        image.isTemplate = true
        return image
    }
}
