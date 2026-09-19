import AppKit
import MenuBarCore

public final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    /// A key-capable panel rather than `NSPopover`.
    ///
    /// This is the single most-tested decision in this file. `NSPopover` from an
    /// accessory (`LSUIElement`) process creates a window that never appears in
    /// `NSApp.windows` and reports `canBecomeKey == false`, so macOS will not route key
    /// events to it no matter how the process is activated — Escape and the Tab path
    /// simply never arrive. A `nonactivatingPanel` that overrides `canBecomeKey`
    /// measures as `canBecomeKey=1 isKey=1` under the same conditions.
    private let panel = PopoverPanel()
    private let controller = PopoverViewController()
    private var coordinator: PollingCoordinator?
    private var actions: ActionCoordinator?
    private var client: ProxyClient?
    private let widgetStore = WidgetSnapshotStore()
    /// The snapshot the UI is currently showing, for decisions that need context
    /// (the start command to display, the default provider to protect).
    private var latest: ProxySnapshot?
    private var endpoint = ProxyEndpoint.default
    private var pollTask: Task<Void, Never>?
    /// Fallback Escape handling for the case where the panel is visible but another
    /// process holds focus. Installed on open, removed on close.
    private var escapeMonitor: Any?

    public override init() { super.init() }

    public func applicationDidFinishLaunching(_ notification: Notification) {
        endpoint = ProxyDiscovery.resolve()
        let client = ProxyClient(endpoint: endpoint)
        self.client = client
        let coordinator = PollingCoordinator(client: client, endpoint: endpoint)
        self.coordinator = coordinator
        self.actions = ActionCoordinator(client: client)

        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = StatusIcon.image(for: .loading)
        item.button?.imagePosition = .imageOnly
        item.button?.target = self
        item.button?.action = #selector(togglePopover)
        item.button?.setAccessibilityLabel("OpenCodex proxy status")
        statusItem = item

        controller.onDashboard = { [weak self] in self?.openDashboard() }
        controller.onCompanionSettings = { [weak self] in self?.openCompanionSettings() }
        controller.onStop = { [weak self] in self?.stopProxy() }
        controller.onRefresh = { [weak self] in self?.refreshNow() }
        controller.onAddKey = { [weak self] in self?.openDashboard() }
        controller.onRetry = { [weak self] in self?.refreshNow() }
        controller.onToggleProvider = { [weak self] name, disable in
            self?.toggleProvider(name, disable: disable)
        }
        controller.onQuit = { NSApp.terminate(nil) }

        panel.contentViewController = controller
        panel.onDismiss = { [weak self] in self?.handlePanelClosed() }

        // The observer closure is `@Sendable` and crosses actor boundaries, so it must
        // not capture the delegate. It hops to the main actor and looks the delegate up
        // there instead.
        Task {
            await coordinator.observe { snapshot in
                Task { @MainActor in
                    (NSApp.delegate as? AppDelegate)?.render(snapshot)
                }
            }
            await MainActor.run { (NSApp.delegate as? AppDelegate)?.startPolling() }
        }
    }

    public func applicationWillTerminate(_ notification: Notification) {
        pollTask?.cancel()
        removeEscapeMonitor()
        panel.dismiss()
    }

    // MARK: - Polling

    @MainActor
    fileprivate func startPolling() {
        guard let coordinator else { return }
        pollTask?.cancel()
        pollTask = Task {
            while !Task.isCancelled {
                await coordinator.refresh()
                let interval = await coordinator.currentInterval
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
            }
        }
    }

    private func refreshNow() {
        Task { [coordinator] in await coordinator?.refresh(includeHeavy: true) }
    }

    @MainActor
    fileprivate func render(_ snapshot: ProxySnapshot) {
        latest = snapshot
        let title = snapshot.menuBarTitle ?? ""
        statusItem?.button?.title = title
        statusItem?.button?.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .medium)
        statusItem?.button?.imagePosition = title.isEmpty ? .imageOnly : .imageLeading
        statusItem?.button?.image = StatusIcon.image(for: snapshot.state)
        statusItem?.button?.toolTip = "OpenCodex — \(snapshot.state.title) (\(snapshot.endpoint.display))"
        controller.apply(snapshot)
        let widgetSnapshot = WidgetSnapshot.make(from: snapshot)
        Task.detached { [widgetStore] in widgetStore.writeIfChanged(widgetSnapshot) }
    }

    // MARK: - Actions

    #if DEBUG
    /// Testing hook: drives the exact presentation path a status-item click uses, so a
    /// harness can verify key focus and Escape without Accessibility permission.
    /// Debug-only — it is not part of the shipped surface.
    public func debugTogglePanel() { togglePopover() }
    #endif

    @objc private func togglePopover() {
        guard let button = statusItem?.button else { return }
        if panel.isShown {
            panel.dismiss()
        } else {
            panel.present(from: button)
            installEscapeMonitor()
            Task { [coordinator] in await coordinator?.setPopoverOpen(true) }
        }
    }

    /// Called by the panel whenever it closes, however it was dismissed.
    private func handlePanelClosed() {
        removeEscapeMonitor()
        Task { [coordinator] in await coordinator?.setPopoverOpen(false) }
    }

    /// The panel is key-capable, so `cancelOperation(_:)` handles Escape in the normal
    /// case. This local monitor is belt-and-braces for the window where the panel is up
    /// but focus sits elsewhere in this process, such as the confirmation sheet.
    private func installEscapeMonitor() {
        removeEscapeMonitor()
        escapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            // While a confirmation is up, Escape belongs to the alert: consuming it
            // here dismissed the panel and stranded the alert with no way to cancel.
            guard event.keyCode == 53,
                  self?.panel.isShown == true,
                  self?.panel.isPresentingModal == false
            else { return event }
            self?.panel.dismiss()
            return nil
        }
    }


    private func removeEscapeMonitor() {
        if let monitor = escapeMonitor { NSEvent.removeMonitor(monitor) }
        escapeMonitor = nil
    }

    private func openDashboard() {
        NSWorkspace.shared.open(endpoint.baseURL)
    }

    private func openCompanionSettings() {
        guard let url = URL(string: "\(endpoint.baseURL.absoluteString)/#/usage#usage-section-companion") else { return }
        NSWorkspace.shared.open(url)
    }

    /// Stopping is destructive: it interrupts in-flight requests and stops the launchd
    /// service, so nothing restarts the proxy. It always confirms first.
    private func stopProxy() {
        let alert = NSAlert()
        alert.messageText = "Stop the OpenCodex proxy?"
        alert.informativeText =
            "In-flight requests will be interrupted, and OpenCodex will not restart on its own."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Stop proxy")
        alert.addButton(withTitle: "Cancel")

        // The alert takes key focus, which would otherwise trip resignKey and dismiss
        // the panel behind it — leaving a user who chose Cancel with nothing.
        panel.isPresentingModal = true
        NSApp.activate(ignoringOtherApps: true)
        let confirmed = alert.runModal() == .alertFirstButtonReturn
        panel.isPresentingModal = false

        guard confirmed else {
            panel.makeKeyAndOrderFront(nil)
            return
        }

        let startCommand = latest?.lastKnownStartCommand ?? "ocx start"
        controller.showResult("Stopping…", isError: false)

        Task { [actions, coordinator] in
            let outcome = await actions?.stop(startCommand: startCommand) ?? .failed("Unavailable.")
            await coordinator?.refresh()
            await MainActor.run { [weak self] in
                switch outcome {
                case .succeeded:
                    self?.controller.showResult("Proxy stopped.", isError: false)
                case .requiresManualStart(let command):
                    // Not a failure — the API has no start endpoint by design.
                    self?.controller.showResult("Proxy stopped. Start it again with \(command)", isError: false)
                case .stoppedWithRestoreFailure(let command):
                    // The proxy is down but native Codex still points at the dead port.
                    self?.controller.showResult(
                        "Proxy stopped, but restoring native Codex failed. Run `ocx restore`, then \(command)",
                        isError: true
                    )
                case .failed(let message):
                    self?.controller.showResult(message, isError: true)
                }
            }
        }
    }

    /// Optimistic toggle: the switch has already moved, so a rejection must move it back
    /// rather than leave the UI showing a state the proxy refused.
    private func toggleProvider(_ name: String, disable: Bool) {
        let defaultProvider = latest?.defaultProvider
        controller.setProviderBusy(name, true, intended: !disable)

        Task { [actions, coordinator] in
            let outcome = await actions?.setProvider(name, disabled: disable, defaultProvider: defaultProvider)
                ?? .failed("Unavailable.")
            await MainActor.run { [weak self] in
                switch outcome {
                case .succeeded:
                    self?.controller.showResult(
                        disable ? "\(name) disabled." : "\(name) enabled.",
                        isError: false
                    )
                case .failed(let message):
                    self?.controller.revertProvider(name, to: !disable)
                    self?.controller.showResult(message, isError: true)
                case .requiresManualStart, .stoppedWithRestoreFailure:
                    // Not reachable for a provider write.
                    break
                }
            }
            // Re-read so the summary line and switch states match the proxy, not our
            // optimistic guess. refreshAndWait rather than refresh: a coalesced refresh
            // returns immediately, which would re-enable the switch against pre-write
            // data.
            await coordinator?.refreshAndWait()
            await MainActor.run { [weak self] in
                self?.controller.setProviderBusy(name, false)
            }
        }
    }
}
