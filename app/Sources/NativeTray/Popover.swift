import AppKit
import SwiftUI

// All ABI calls run on Tauri's AppKit main thread. Swift copies the borrowed JSON
// synchronously and never retains a Rust buffer or owns an application/run loop.
@MainActor
private final class NativeTrayPopover: NSObject {
    static let shared = NativeTrayPopover()
    let panel = NativeTrayPanel()
    let store = NativeTrayStore()
    var callback: (@convention(c) (Int32) -> Void)?

    override init() {
        super.init()
        panel.contentViewController = NativeTrayHostingController(store: store)
        panel.onDismiss = { [weak self] in self?.callback?(2) }
        store.action = { [weak self] event in
            guard let self else { return }
            if event == 2 || event == 3 || event == 4 { self.panel.dismiss() }
            if event != 2 { self.callback?(event) }
        }
    }

    func show(_ pointer: UnsafeMutableRawPointer, toggle: Bool, callback: @escaping @convention(c) (Int32) -> Void) {
        self.callback = callback
        if toggle && panel.isVisible { panel.dismiss(); return }
        let item = Unmanaged<NSStatusItem>.fromOpaque(pointer).takeUnretainedValue()
        guard let button = item.button, button.window != nil else { return }
        if panel.isVisible { return }
        panel.present(from: button)
        if panel.isVisible { callback(1) }
    }

}

@MainActor
private final class UpdateDotView: NSView {
    weak var statusButton: NSStatusBarButton?

    init(button: NSStatusBarButton) {
        statusButton = button
        super.init(frame: button.bounds)
        autoresizingMask = [.width, .height]
        // AppKit keeps the template image and its highlighted tint. This view draws only
        // the independent accent, without making the status button layer-backed.
        wantsLayer = false
    }

    required init?(coder: NSCoder) { nil }
    override var isOpaque: Bool { false }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func layout() {
        super.layout()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let button = statusButton else { return }
        let imageRect = button.cell?.imageRect(forBounds: button.bounds) ?? button.bounds
        let image = imageRect.isEmpty ? button.bounds : imageRect
        let diameter: CGFloat = 7
        let dot = NSRect(x: min(bounds.maxX - diameter, image.maxX - 4),
                         y: max(bounds.minY, image.minY + 1),
                         width: diameter, height: diameter)
        NSColor.windowBackgroundColor.setFill()
        NSBezierPath(ovalIn: dot.insetBy(dx: -1.25, dy: -1.25)).fill()
        NSColor(calibratedRed: 0.18, green: 0.48, blue: 0.97, alpha: 1).setFill()
        NSBezierPath(ovalIn: dot).fill()
    }
}

@MainActor
private enum UpdateDot {
    static weak var button: NSStatusBarButton?
    static var view: UpdateDotView?

    static func set(_ item: NSStatusItem, visible: Bool) {
        guard let next = item.button else { return }
        if button !== next {
            view?.removeFromSuperview()
            view = nil
            button = next
        }
        guard visible else {
            view?.removeFromSuperview()
            view = nil
            return
        }
        if view == nil {
            let overlay = UpdateDotView(button: next)
            next.addSubview(overlay)
            view = overlay
        }
        view?.frame = next.bounds
        view?.needsDisplay = true
    }
}

@_cdecl("ocx_native_tray_update_dot")
@MainActor
public func nativeTrayUpdateDot(_ item: UnsafeMutableRawPointer?, _ show: Int32) {
    guard Thread.isMainThread, let item else { return }
    let statusItem = Unmanaged<NSStatusItem>.fromOpaque(item).takeUnretainedValue()
    UpdateDot.set(statusItem, visible: show != 0)
}

@_cdecl("ocx_native_tray_show")
@MainActor
public func nativeTrayShow(_ item: UnsafeMutableRawPointer?, _ toggle: Int32, _ callback: @escaping @convention(c) (Int32) -> Void) {
    guard Thread.isMainThread, let item else { return }
    NativeTrayPopover.shared.show(item, toggle: toggle != 0, callback: callback)
}

@_cdecl("ocx_native_tray_hide")
@MainActor
public func nativeTrayHide() {
    guard Thread.isMainThread else { return }
    NativeTrayPopover.shared.panel.dismiss()
}

@_cdecl("ocx_native_tray_visible")
@MainActor
public func nativeTrayVisible() -> Int32 {
    guard Thread.isMainThread else { return 0 }
    return NativeTrayPopover.shared.panel.isVisible ? 1 : 0
}

@_cdecl("ocx_native_tray_update")
@MainActor
public func nativeTrayUpdate(_ bytes: UnsafePointer<UInt8>?, _ count: Int) {
    guard Thread.isMainThread, let bytes, count > 0, count <= 8 * 1024 * 1024 else { return }
    let store = NativeTrayPopover.shared.store
    do {
        store.snapshot = try NativeTraySnapshot.decode(Data(bytes: bytes, count: count))
        store.decodeFailed = false
    } catch {
        store.decodeFailed = true
    }
}
