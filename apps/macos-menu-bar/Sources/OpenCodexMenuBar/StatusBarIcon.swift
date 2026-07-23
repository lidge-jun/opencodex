import AppKit

enum StatusBarIcon {
    private static let size = NSSize(width: 22, height: 22)
    private static let cropRatio: CGFloat = 0.09375
    private static let verticalOffset: CGFloat = -1

    static func make(accessibilityDescription: String) -> NSImage? {
        guard let imageURL = Bundle.main.url(forResource: "OpenCodexMenuBar", withExtension: "png"),
              let sourceImage = NSImage(contentsOf: imageURL) else {
            return fallback(accessibilityDescription: accessibilityDescription)
        }

        let sourceRect = NSRect(origin: .zero, size: sourceImage.size).insetBy(
            dx: sourceImage.size.width * cropRatio,
            dy: sourceImage.size.height * cropRatio
        )
        let image = NSImage(size: size, flipped: false) { destinationRect in
            let alignedRect = destinationRect.offsetBy(dx: 0, dy: verticalOffset)
            sourceImage.draw(in: alignedRect, from: sourceRect, operation: .sourceOver, fraction: 1)
            return true
        }
        image.isTemplate = true
        return image
    }

    private static func fallback(accessibilityDescription: String) -> NSImage? {
        let configuration = NSImage.SymbolConfiguration(pointSize: 15, weight: .medium)
        let image = NSImage(systemSymbolName: "network", accessibilityDescription: accessibilityDescription)?
            .withSymbolConfiguration(configuration)
        image?.isTemplate = true
        return image
    }
}
