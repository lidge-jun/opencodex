import AppKit
import SwiftUI

/// A single native material surface inside a transparent AppKit panel.
/// The SwiftUI content deliberately paints no web-style background or second radius.
@MainActor
final class NativeTrayHostingController: NSViewController {
    private let hosting: NSHostingController<NativeTrayUsageView>

    static var usesLiquidGlass: Bool {
        #if compiler(>=6.2)
        if #available(macOS 26.0, *) { return true }
        #endif
        return false
    }

    init(store: NativeTrayStore) {
        hosting = NSHostingController(rootView: NativeTrayUsageView(store: store))
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { nil }

    override func loadView() {
        addChild(hosting)
        #if compiler(>=6.2)
        if #available(macOS 26.0, *) {
            let glass = NSGlassEffectView()
            glass.style = .regular
            glass.cornerRadius = 16
            glass.contentView = hosting.view
            view = glass
            hosting.view.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                hosting.view.leadingAnchor.constraint(equalTo: glass.safeAreaLayoutGuide.leadingAnchor),
                hosting.view.trailingAnchor.constraint(equalTo: glass.safeAreaLayoutGuide.trailingAnchor),
                hosting.view.topAnchor.constraint(equalTo: glass.safeAreaLayoutGuide.topAnchor),
                hosting.view.bottomAnchor.constraint(equalTo: glass.safeAreaLayoutGuide.bottomAnchor),
            ])
            return
        }
        #endif
        let material = NSVisualEffectView()
        material.material = .popover
        material.blendingMode = .behindWindow
        material.state = .active
        material.wantsLayer = true
        material.layer?.cornerRadius = 16
        material.layer?.masksToBounds = true
        material.addSubview(hosting.view)
        hosting.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            hosting.view.leadingAnchor.constraint(equalTo: material.leadingAnchor),
            hosting.view.trailingAnchor.constraint(equalTo: material.trailingAnchor),
            hosting.view.topAnchor.constraint(equalTo: material.topAnchor),
            hosting.view.bottomAnchor.constraint(equalTo: material.bottomAnchor),
        ])
        view = material
    }
}
