import AppKit

/// The popover surface.
///
/// Deliberately a panel rather than `NSPopover`. Measured on macOS 27 from an accessory
/// (`LSUIElement`) process: the window `NSPopover` creates never appears in
/// `NSApp.windows` and reports `canBecomeKey == false`, so the OS refuses to route key
/// events to it — Escape and Tab never arrive regardless of how the process is
/// activated. The same probe against this panel reports `canBecomeKey=1 isKey=1`.
///
/// `nonactivatingPanel` keeps the click-through feel of a menu bar popover: opening it
/// does not steal focus from the user's editor.
public final class PopoverPanel: NSPanel {
    /// Invoked whenever the panel closes, however it was dismissed.
    public var onDismiss: (() -> Void)?

    private var clickOutsideMonitor: Any?

    public init() {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 340, height: 300),
            styleMask: [.nonactivatingPanel, .fullSizeContentView, .borderless],
            backing: .buffered,
            defer: false
        )
        isFloatingPanel = true
        level = .statusBar
        hidesOnDeactivate = false
        becomesKeyOnlyIfNeeded = false
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        isMovable = false
        animationBehavior = .utilityWindow
    }

    /// Wraps the content in a real popover material.
    ///
    /// A borderless panel has NO background of its own: without this the dashboard
    /// composites straight onto whatever application is underneath, so labels collide
    /// with the app behind it and contrast depends on that app's colours. `NSPopover`
    /// supplies this surface automatically; a panel must build it.
    public override var contentViewController: NSViewController? {
        didSet {
            guard let content = contentViewController?.view else { return }
            let effect = NSVisualEffectView()
            effect.material = .popover
            effect.blendingMode = .behindWindow
            effect.state = .active
            effect.wantsLayer = true
            effect.layer?.cornerRadius = 10
            effect.layer?.masksToBounds = true
            effect.translatesAutoresizingMaskIntoConstraints = false

            let host = NSView()
            host.addSubview(effect)
            effect.addSubview(content)
            content.translatesAutoresizingMaskIntoConstraints = false

            NSLayoutConstraint.activate([
                effect.topAnchor.constraint(equalTo: host.topAnchor),
                effect.leadingAnchor.constraint(equalTo: host.leadingAnchor),
                effect.trailingAnchor.constraint(equalTo: host.trailingAnchor),
                effect.bottomAnchor.constraint(equalTo: host.bottomAnchor),
                content.topAnchor.constraint(equalTo: effect.topAnchor),
                content.leadingAnchor.constraint(equalTo: effect.leadingAnchor),
                content.trailingAnchor.constraint(equalTo: effect.trailingAnchor),
                content.bottomAnchor.constraint(equalTo: effect.bottomAnchor),
            ])
            contentView = host
        }
    }

    /// Suspends resign-key dismissal, so presenting a modal sheet does not tear the
    /// panel down behind it and strand a user who chose Cancel.
    public var isPresentingModal = false

    public override var canBecomeKey: Bool { true }
    /// Never main: this is chrome, not a document window.
    public override var canBecomeMain: Bool { false }

    public var isShown: Bool { isVisible }

    /// Presents under a status item button, clamped to the visible screen.
    public func present(from button: NSStatusBarButton) {
        guard let buttonWindow = button.window else { return }
        layoutContent()

        let size = contentViewController?.preferredContentSize ?? frame.size
        setContentSize(size)

        let buttonRect = buttonWindow.convertToScreen(button.convert(button.bounds, to: nil))
        var origin = NSPoint(
            x: buttonRect.midX - size.width / 2,
            y: buttonRect.minY - size.height - 6
        )

        if let screen = buttonWindow.screen ?? NSScreen.main {
            let visible = screen.visibleFrame
            origin.x = min(max(origin.x, visible.minX + 8), visible.maxX - size.width - 8)
            origin.y = max(origin.y, visible.minY + 8)
        }

        setFrameOrigin(origin)
        makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        installClickOutsideMonitor()
    }

    public func dismiss() {
        // Idempotent: a late monitor callback must not re-run teardown.
        guard isVisible else { return }
        removeClickOutsideMonitor()
        orderOut(nil)
        onDismiss?()
    }

    /// Transient behaviour: clicking anywhere else dismisses, matching what a menu bar
    /// popover trained the user to expect.
    private func installClickOutsideMonitor() {
        removeClickOutsideMonitor()
        clickOutsideMonitor = NSEvent.addGlobalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown]
        ) { [weak self] _ in
            self?.dismiss()
        }
    }

    private func removeClickOutsideMonitor() {
        if let monitor = clickOutsideMonitor { NSEvent.removeMonitor(monitor) }
        clickOutsideMonitor = nil
    }

    public override func cancelOperation(_ sender: Any?) { dismiss() }

    public override func resignKey() {
        super.resignKey()
        // Losing key focus means the user moved on — unless we put the focus elsewhere
        // ourselves by presenting a confirmation.
        guard !isPresentingModal else { return }
        if isVisible { dismiss() }
    }

    private func layoutContent() {
        contentViewController?.view.layoutSubtreeIfNeeded()
    }
}
