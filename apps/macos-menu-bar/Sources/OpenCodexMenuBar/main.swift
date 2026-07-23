import AppKit
import Foundation
import OpenCodexMenuBarCore

private enum MenuConfiguration {
    static let width: CGFloat = 280
    static let refreshInterval: TimeInterval = 15
    static let operationRefreshDelays: [TimeInterval] = [0.8, 2, 5]
}

private final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let locator = OcxLocator()
    private lazy var client = OcxClient(locator: locator)
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    private let menu = NSMenu()
    private let detailsMenu = NSMenu()

    private let phaseItem = NSMenuItem()
    private let detailItem = NSMenuItem()
    private let runtimeItem = NSMenuItem()
    private let serviceItem = NSMenuItem()
    private let cliItem = NSMenuItem()
    private let openDashboardItem = NSMenuItem(title: Text.openDashboard, action: #selector(openDashboard), keyEquivalent: "d")
    private let startItem = NSMenuItem(title: Text.start, action: #selector(startProxy), keyEquivalent: "")
    private let restartItem = NSMenuItem(title: Text.restart, action: #selector(restartProxy), keyEquivalent: "")
    private let stopItem = NSMenuItem(title: Text.stop, action: #selector(stopProxy), keyEquivalent: "")
    private let refreshItem = NSMenuItem(title: Text.refresh, action: #selector(refreshStatusFromMenu), keyEquivalent: "r")
    private let chooseCLIItem = NSMenuItem(title: Text.chooseCLI, action: #selector(chooseCLI), keyEquivalent: "")
    private let resetCLIItem = NSMenuItem(title: Text.resetCLI, action: #selector(resetCLI), keyEquivalent: "")
    private var currentStatus: OcxStatus?
    private var phase: ProxyPhase = .checking
    private var busyOperation: ProxyControlOperation?
    private var refreshInFlight = false
    private var timer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        configureStatusItem()
        configureMenu()
        render()
        refreshStatus()
        timer = Timer.scheduledTimer(withTimeInterval: MenuConfiguration.refreshInterval, repeats: true) { [weak self] _ in
            self?.refreshStatus()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate()
    }

    func menuWillOpen(_ menu: NSMenu) {
        refreshStatus()
    }

    private func configureStatusItem() {
        guard let button = statusItem.button else { return }
        button.image = StatusBarIcon.make(accessibilityDescription: Text.appName)
        button.imagePosition = .imageOnly
        button.toolTip = Text.appName
        button.setAccessibilityLabel(Text.appName)
        statusItem.menu = menu
    }

    private func configureMenu() {
        menu.delegate = self
        menu.autoenablesItems = false
        menu.minimumWidth = MenuConfiguration.width
        detailsMenu.autoenablesItems = false

        let header = NSMenuItem()
        header.attributedTitle = NSAttributedString(
            string: Text.appName,
            attributes: [.font: NSFont.systemFont(ofSize: 13, weight: .semibold)]
        )
        header.isEnabled = false
        menu.addItem(header)

        phaseItem.isEnabled = true
        phaseItem.submenu = detailsMenu
        menu.addItem(phaseItem)

        for item in [detailItem, runtimeItem, serviceItem, cliItem] {
            item.isEnabled = false
            detailsMenu.addItem(item)
        }

        menu.addItem(.separator())
        for item in [openDashboardItem, startItem, restartItem, stopItem] {
            item.target = self
            menu.addItem(item)
        }

        menu.addItem(.separator())
        for item in [refreshItem, chooseCLIItem, resetCLIItem] {
            item.target = self
            menu.addItem(item)
        }

        menu.addItem(.separator())
        let quitItem = NSMenuItem(title: Text.quit, action: #selector(quitApp), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(quitItem)
    }

    private func refreshStatus() {
        guard !refreshInFlight, busyOperation == nil else { return }
        guard client.executableURL != nil else {
            currentStatus = nil
            phase = .cliMissing
            render()
            return
        }

        refreshInFlight = true
        client.fetchStatus { [weak self] result in
            guard let self else { return }
            self.refreshInFlight = false
            switch result {
            case .success(let status):
                self.currentStatus = status
                self.phase = status.phase
            case .failure(let error):
                self.currentStatus = nil
                if case OcxClientError.executableNotFound = error {
                    self.phase = .cliMissing
                } else {
                    self.phase = .failed
                }
            }
            self.render()
        }
    }

    private func render() {
        let displayPhase: ProxyPhase = busyOperation == nil ? phase : .checking
        let canExpandDetails = currentStatus != nil || client.executableURL != nil
        phaseItem.title = title(for: displayPhase)
        phaseItem.image = phaseImage(for: displayPhase)
        phaseItem.submenu = canExpandDetails ? detailsMenu : nil

        let status = currentStatus
        let detailText = status.map(detailTitle) ?? "—"
        detailItem.attributedTitle = NSAttributedString(
            string: detailText,
            attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)]
        )
        detailItem.toolTip = detailText
        detailItem.isHidden = status == nil

        let runtimeTitle = status.map { "\(Text.runtime) · \($0.runtime.source)" } ?? ""
        runtimeItem.title = runtimeTitle
        runtimeItem.toolTip = runtimeTitle
        runtimeItem.isHidden = status == nil

        let serviceDetail = status.map(serviceTitle) ?? ""
        serviceItem.title = serviceDetail
        serviceItem.toolTip = serviceDetail
        serviceItem.isHidden = status == nil

        if let executable = client.executableURL {
            let cliTitle = "\(Text.cli) · \(abbreviatedPath(executable.path))"
            cliItem.title = cliTitle
            cliItem.toolTip = executable.path
            cliItem.isHidden = false
        } else {
            cliItem.title = ""
            cliItem.toolTip = nil
            cliItem.isHidden = true
        }

        let isBusy = busyOperation != nil
        let canStop = status.map { $0.proxy.pid != nil || $0.proxy.health.ok } ?? false
        let hasCLI = client.executableURL != nil
        openDashboardItem.isEnabled = !isBusy && (status?.proxy.health.ok ?? false)
        startItem.isHidden = canStop
        startItem.isEnabled = !isBusy && hasCLI && status != nil
        restartItem.isHidden = !canStop
        restartItem.isEnabled = !isBusy && hasCLI
        stopItem.isHidden = !canStop
        stopItem.isEnabled = !isBusy && hasCLI
        refreshItem.isEnabled = !isBusy && hasCLI
        chooseCLIItem.isEnabled = !isBusy
        resetCLIItem.isHidden = !locator.hasCustomPath
        resetCLIItem.isEnabled = !isBusy

        statusItem.button?.toolTip = "\(Text.appName) — \(title(for: displayPhase))"
    }

    private func title(for phase: ProxyPhase) -> String {
        if let operation = busyOperation {
            switch operation {
            case .start: return Text.starting
            case .restart: return Text.restarting
            case .stop: return Text.stopping
            }
        }
        switch phase {
        case .checking: return Text.checking
        case .running: return Text.running
        case .stopped: return Text.stopped
        case .degraded: return Text.degraded
        case .cliMissing: return Text.cliMissing
        case .failed: return Text.failed
        }
    }

    private func phaseImage(for phase: ProxyPhase) -> NSImage? {
        let color: NSColor
        switch phase {
        case .running: color = .systemGreen
        case .degraded: color = .systemOrange
        case .failed, .cliMissing: color = .systemRed
        case .checking: color = .secondaryLabelColor
        case .stopped: color = .tertiaryLabelColor
        }
        let base = NSImage.SymbolConfiguration(pointSize: 8, weight: .semibold)
        let tint = NSImage.SymbolConfiguration(hierarchicalColor: color)
        return NSImage(systemSymbolName: "circle.fill", accessibilityDescription: nil)?
            .withSymbolConfiguration(base.applying(tint))
    }

    private func detailTitle(_ status: OcxStatus) -> String {
        var details: [String] = []
        if let version = status.proxy.health.version { details.append("v\(version)") }
        if let pid = status.proxy.pid { details.append("PID \(pid)") }
        details.append(Text.isKorean ? "포트 \(status.listen.port)" : "Port \(status.listen.port)")
        if let uptime = status.proxy.health.uptimeSeconds, uptime >= 1 {
            details.append(uptimeTitle(uptime))
        }
        return details.joined(separator: " · ")
    }

    private func uptimeTitle(_ seconds: Double) -> String {
        let formatter = DateComponentsFormatter()
        formatter.allowedUnits = seconds >= 86_400 ? [.day, .hour] : seconds >= 3_600 ? [.hour, .minute] : [.minute, .second]
        formatter.unitsStyle = .abbreviated
        formatter.maximumUnitCount = 2
        let value = formatter.string(from: max(1, seconds)) ?? "\(Int(seconds))s"
        return Text.isKorean ? "가동 \(value)" : "Up \(value)"
    }

    private func serviceTitle(_ status: OcxStatus) -> String {
        guard status.serviceInstalled else { return Text.noService }
        return status.service.summary.contains("not loaded") ? Text.serviceStopped : Text.serviceRunning
    }

    private func abbreviatedPath(_ path: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return path.hasPrefix(home + "/") ? "~" + path.dropFirst(home.count) : path
    }

    @objc private func openDashboard() {
        guard let rawURL = currentStatus?.dashboard.url, let url = URL(string: rawURL) else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func startProxy() {
        perform(.start)
    }

    @objc private func restartProxy() {
        guard confirm(title: Text.restartTitle, button: Text.confirmRestart) else { return }
        perform(.restart)
    }

    @objc private func stopProxy() {
        guard confirm(title: Text.stopTitle, button: Text.confirmStop) else { return }
        perform(.stop)
    }

    private func perform(_ operation: ProxyControlOperation) {
        guard let status = currentStatus else { return }
        busyOperation = operation
        render()
        client.perform(operation, status: status) { [weak self] result in
            guard let self else { return }
            self.busyOperation = nil
            if case .failure(let error) = result {
                self.presentError(error.localizedDescription)
            }
            self.phase = .checking
            self.render()
            self.refreshStatus()
            for delay in MenuConfiguration.operationRefreshDelays {
                DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                    self?.refreshStatus()
                }
            }
        }
    }

    private func confirm(title: String, button: String) -> Bool {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = title
        alert.informativeText = Text.interruptionWarning
        alert.addButton(withTitle: button)
        alert.addButton(withTitle: Text.cancel)
        return alert.runModal() == .alertFirstButtonReturn
    }

    private func presentError(_ message: String) {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = Text.actionFailed
        alert.informativeText = message
        alert.runModal()
    }

    @objc private func refreshStatusFromMenu() {
        phase = .checking
        render()
        refreshStatus()
    }

    @objc private func chooseCLI() {
        NSApp.activate(ignoringOtherApps: true)
        let panel = NSOpenPanel()
        panel.title = Text.chooseCLI
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        guard FileManager.default.isExecutableFile(atPath: url.path) else {
            presentError(Text.invalidCLI)
            return
        }
        locator.saveCustomPath(url)
        currentStatus = nil
        phase = .checking
        render()
        refreshStatus()
    }

    @objc private func resetCLI() {
        locator.clearCustomPath()
        currentStatus = nil
        phase = .checking
        render()
        refreshStatus()
    }

    @objc private func quitApp() {
        NSApp.terminate(nil)
    }
}

let app = NSApplication.shared
private let appDelegate = AppDelegate()
app.delegate = appDelegate
app.run()
