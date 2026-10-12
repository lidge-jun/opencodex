import AppKit

/// Adapted from the native companion's PopoverPanel in commit 38a5ab9fc4.
/// A key-capable panel avoids the accessory NSPopover keyboard failure measured
/// there on macOS 27, while leaving application/runtime ownership with Tauri.
@MainActor
final class NativeTrayPanel: NSPanel {
    var onDismiss: (() -> Void)?
    private var outsideMonitor: Any?

    init() {
        super.init(contentRect: NSRect(x: 0, y: 0, width: 420, height: 660),
                   styleMask: [.nonactivatingPanel, .fullSizeContentView, .borderless],
                   backing: .buffered, defer: false)
        title = "OpenCodex Usage"
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

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    func present(from button: NSStatusBarButton) {
        guard let buttonWindow = button.window else { return }
        let visible = (buttonWindow.screen ?? NSScreen.main)?.visibleFrame
            ?? NSRect(x: 0, y: 0, width: 1024, height: 768)
        let size = NSSize(width: min(420, max(160, visible.width - 16)),
                          height: min(660, max(160, visible.height - 16)))
        setContentSize(size)
        let anchor = buttonWindow.convertToScreen(button.convert(button.bounds, to: nil))
        setFrameOrigin(NSPoint(
            x: min(max(anchor.midX - size.width / 2, visible.minX + 8), visible.maxX - size.width - 8),
            y: max(visible.minY + 8, anchor.minY - size.height - 6)))
        makeKeyAndOrderFront(nil)
        if outsideMonitor == nil {
            outsideMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
                self?.dismiss()
            }
        }
    }

    func dismiss() {
        guard isVisible else { return }
        if let outsideMonitor { NSEvent.removeMonitor(outsideMonitor) }
        outsideMonitor = nil
        orderOut(nil)
        onDismiss?()
    }

    override func cancelOperation(_ sender: Any?) { dismiss() }
    override func resignKey() {
        super.resignKey()
        dismiss()
    }
}
