import AppKit
import SwiftUI

public enum NativeTrayIcon {
    /// Decodes a provider mark. AppKit reads SVG data into an `NSImage`; anything it cannot read,
    /// or reads as an empty image, is no mark rather than a blank square.
    public static func image(svg: String) -> NSImage? {
        guard let data = svg.data(using: .utf8), let image = NSImage(data: data),
              image.size.width > 0, image.size.height > 0 else { return nil }
        return image
    }
}

/// Decoding an SVG on every redraw would repeat work for marks that never change.
@MainActor
private enum NativeTrayIconCache {
    private static var images: [String: NSImage] = [:]
    private static var unreadable: Set<String> = []

    static func image(id: String, svg: String) -> NSImage? {
        let key = "\(id):\(svg.utf8.count):\(svg.hashValue)"
        if let image = images[key] { return image }
        if unreadable.contains(key) { return nil }
        guard let image = NativeTrayIcon.image(svg: svg) else {
            unreadable.insert(key)
            return nil
        }
        images[key] = image
        return image
    }
}

/// A provider's mark, painted the way the dashboard paints it so it survives both appearances:
/// `mask` marks are one neutral ink and take the label color, `plate` and `dark-plate` marks sit
/// on the constant plate their artwork assumes, and `image` marks are drawn as they are.
struct NativeTrayProviderMark: View {
    let provider: NativeTrayProvider

    var body: some View {
        if let svg = provider.iconSvg, let image = NativeTrayIconCache.image(id: provider.id, svg: svg) {
            let paint = provider.iconPaint ?? "image"
            let mark = Image(nsImage: image)
                .resizable()
                .renderingMode(paint == "mask" ? .template : .original)
                .aspectRatio(contentMode: .fit)
            Group {
                if paint == "plate" || paint == "dark-plate" {
                    mark.padding(2)
                        .background(RoundedRectangle(cornerRadius: 4, style: .continuous)
                            .fill(paint == "plate" ? Color(white: 0.96) : Color(white: 0.14)))
                } else {
                    mark.foregroundStyle(.primary)
                }
            }
            .frame(width: 16, height: 16)
            .accessibilityHidden(true)
        }
    }
}

/// Quota bar drawn from shapes, colored by the dashboard's severity thresholds. It replaces an
/// AppKit-backed `ProgressView` tinted a fixed green, which showed a 100% window as healthy.
struct NativeTrayQuotaBar: View {
    let window: NativeTrayProvider.Window

    private var color: Color {
        switch NativeTrayFormat.severity(window.value) {
        case .normal: return .green
        case .warn: return .orange
        case .critical: return .red
        }
    }

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.1))
                if let value = window.value {
                    Capsule().fill(color)
                        .frame(width: value > 0 ? max(6, geometry.size.width * window.fill) : 0)
                }
            }
        }
        .frame(height: 6)
        .accessibilityElement()
        .accessibilityLabel(window.label)
        .accessibilityValue(NativeTrayFormat.percentDescription(window.value))
    }
}
