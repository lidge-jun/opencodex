import AppKit
import MenuBarCore

/// The popover body: one column ordered by urgency.
///
/// Deliberately not a tab bar. A menu bar popover is a glance surface, and tabs would put
/// the answer to "is it fine?" one click away three times out of four.
///
/// Fixed header and action row with a scrolling middle: the quota and provider sections
/// grow with the user's configuration, and an uncapped popover would eventually run off
/// the screen.
public final class PopoverViewController: NSViewController {
    public override init(nibName: NSNib.Name?, bundle: Bundle?) {
        super.init(nibName: nibName, bundle: bundle)
    }

    public required init?(coder: NSCoder) { nil }

    /// The popover never grows past this; the variable middle scrolls instead.
    private static let maxHeight: CGFloat = 480

    // Fixed chrome
    private let header = StatusHeaderView()
    private let dashboardButton = NSButton()
    private let stopButton = NSButton()
    private let overflowButton = NSButton()
    /// State-specific call to action: "Add key…" or "Retry".
    private let primaryButton = NSButton()

    // Scrolling body
    private let scrollView = NSScrollView()
    private let body = NSStackView()
    private let metrics = MetricsView()
    private let timelineChart = TimelineChartView()
    private let models = ModelsListView()
    private let accounts = AccountsListView()
    private let quotaStack = NSStackView()
    private let quotaEmpty = makeLabel("No provider quota sources connected.", font: Theme.caption, color: Theme.muted)
    private let providers = ProviderListView()
    /// Transient result of the last write action. Actions that report nothing leave the
    /// user guessing whether anything happened.
    private let resultBanner = makeLabel("", font: Theme.caption, color: Theme.muted)
    private let skeleton = SkeletonView()
    private let guidanceLabel: NSTextField = {
        let field = makeLabel("", font: Theme.caption, color: Theme.muted)
        // Guidance is a sentence, not a stat: let it wrap instead of truncating away
        // the half that explains what to do.
        field.lineBreakMode = .byWordWrapping
        field.maximumNumberOfLines = 3
        field.preferredMaxLayoutWidth = Theme.width - Theme.gutter * 2
        return field
    }()
    private let commandField = NSTextField(labelWithString: "")
    private let metricsSeparator = makeSeparator()
    private let quotaSeparator = makeSeparator()

    public var onDashboard: (() -> Void)?
    public var onCompanionSettings: (() -> Void)?
    public var onStop: (() -> Void)?
    public var onQuit: (() -> Void)?
    public var onRefresh: (() -> Void)?
    /// `(provider, shouldDisable)`.
    public var onToggleProvider: ((String, Bool) -> Void)?
    /// Distinct callbacks: "Retry" must retry in place, while "Add key…" navigates to
    /// the dashboard. Routing both through one handler made Retry open a browser.
    public var onAddKey: (() -> Void)?
    public var onRetry: (() -> Void)?

    private var snapshot: ProxySnapshot?
    private var scrollHeight: NSLayoutConstraint?
    /// Guards the banner's auto-hide so a newer result is not cleared by an older timer.
    private var resultToken = 0

    public override func loadView() {
        configureControls()
        resultBanner.isHidden = true
        resultBanner.lineBreakMode = .byWordWrapping
        resultBanner.maximumNumberOfLines = 3
        resultBanner.preferredMaxLayoutWidth = Theme.width - Theme.gutter * 2
        providers.onToggle = { [weak self] name, disable in
            self?.onToggleProvider?(name, disable)
        }

        body.orientation = .vertical
        body.alignment = .leading
        body.spacing = Theme.rowGap
        body.setViews(
            [skeleton, metrics, timelineChart, metricsSeparator, models, quotaStack, quotaEmpty,
             accounts, providers, quotaSeparator, resultBanner, guidanceLabel, commandField],
            in: .top
        )
        body.translatesAutoresizingMaskIntoConstraints = false

        // A flipped clip view puts the scroll origin at the TOP. Without this, content
        // that overflows opens scrolled to the bottom, hiding the status and metrics the
        // urgency order exists to surface first.
        scrollView.contentView = FlippedClipView()
        scrollView.documentView = body
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder
        scrollView.translatesAutoresizingMaskIntoConstraints = false

        let actions = NSStackView(views: [dashboardButton, stopButton, primaryButton, NSView(), overflowButton])
        actions.orientation = .horizontal
        actions.spacing = Theme.rowGap
        actions.alignment = .centerY

        let column = NSStackView(views: [header, makeSeparator(), scrollView, actions])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = Theme.rowGap
        column.edgeInsets = NSEdgeInsets(
            top: Theme.gutter, left: Theme.gutter,
            bottom: Theme.gutter, right: Theme.gutter
        )
        column.translatesAutoresizingMaskIntoConstraints = false

        let root = NSView(frame: NSRect(x: 0, y: 0, width: Theme.width, height: 300))
        root.addSubview(column)

        let contentWidth = Theme.width - Theme.gutter * 2
        NSLayoutConstraint.activate([
            column.topAnchor.constraint(equalTo: root.topAnchor),
            column.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            column.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            column.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            root.widthAnchor.constraint(equalToConstant: Theme.width),
            header.widthAnchor.constraint(equalToConstant: contentWidth),
            actions.widthAnchor.constraint(equalToConstant: contentWidth),
            scrollView.widthAnchor.constraint(equalToConstant: contentWidth),
            body.widthAnchor.constraint(equalToConstant: contentWidth),
        ])

        let heightConstraint = scrollView.heightAnchor.constraint(equalToConstant: 120)
        heightConstraint.isActive = true
        scrollHeight = heightConstraint

        view = root
    }

    private func configureControls() {
        for (button, title) in [(dashboardButton, "Dashboard"), (stopButton, "Stop proxy")] {
            button.title = title
            button.bezelStyle = .rounded
            button.controlSize = .small
            button.font = Theme.caption
            button.target = self
        }
        dashboardButton.action = #selector(dashboardTapped)
        stopButton.action = #selector(stopTapped)

        primaryButton.bezelStyle = .rounded
        primaryButton.controlSize = .small
        primaryButton.font = Theme.caption
        primaryButton.target = self
        primaryButton.action = #selector(primaryTapped)
        primaryButton.isHidden = true

        overflowButton.title = "···"
        overflowButton.bezelStyle = .rounded
        overflowButton.controlSize = .small
        overflowButton.font = Theme.caption
        overflowButton.target = self
        overflowButton.action = #selector(overflowTapped)
        overflowButton.setAccessibilityLabel("More actions")

        quotaStack.orientation = .vertical
        quotaStack.alignment = .leading
        quotaStack.spacing = Theme.tightGap

        commandField.font = Theme.numericSmall
        commandField.textColor = Theme.text
        commandField.isSelectable = true
        commandField.isBordered = false
        commandField.drawsBackground = false
    }

    public func apply(_ snapshot: ProxySnapshot) {
        self.snapshot = snapshot
        header.apply(snapshot)

        let showsData = snapshot.showsData
        let isLoading = !snapshot.hasEverLoaded && snapshot.state == .loading

        // Loading shows structure, not empty copy: the shape of the answer is already
        // known, only the values are missing.
        skeleton.isHidden = !isLoading

        metrics.isHidden = !showsData
        metricsSeparator.isHidden = !showsData
        quotaSeparator.isHidden = !showsData
        if showsData {
            metrics.apply(snapshot)
            timelineChart.apply(snapshot)
            models.apply(snapshot)
            accounts.apply(snapshot)
            applyQuotas(snapshot)
            providers.apply(snapshot)
        } else {
            timelineChart.isHidden = true
            models.isHidden = true
            accounts.isHidden = true
            quotaStack.isHidden = true
            quotaEmpty.isHidden = true
            providers.isHidden = true
        }

        applyGuidance(snapshot)
        applyActions(snapshot, isLoading: isLoading)
        resize()
    }

    private func applyQuotas(_ snapshot: ProxySnapshot) {
        for view in quotaStack.arrangedSubviews {
            quotaStack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        let rows = snapshot.quotaRows
        quotaStack.isHidden = rows.isEmpty
        // "Not fetched yet" and "the proxy reported none" are different facts.
        quotaEmpty.isHidden = !(rows.isEmpty && snapshot.quotasLoaded)
        for quota in rows {
            let row = QuotaRowView(quota: quota)
            row.translatesAutoresizingMaskIntoConstraints = false
            quotaStack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: quotaStack.widthAnchor).isActive = true
        }
    }

    /// Shows the outcome of a write action, then clears itself. A banner that never
    /// leaves would become permanent furniture.
    public func showResult(_ text: String, isError: Bool) {
        resultBanner.stringValue = text
        resultBanner.textColor = isError ? Theme.red : Theme.muted
        resultBanner.isHidden = false
        refreshSize()

        resultToken &+= 1
        let token = resultToken
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in
            guard let self, self.resultToken == token else { return }
            self.resultBanner.isHidden = true
            self.refreshSize()
        }
    }

    public func revertProvider(_ name: String, to enabled: Bool) {
        providers.revert(name, to: enabled)
    }

    public func setProviderBusy(_ name: String, _ busy: Bool, intended: Bool? = nil) {
        providers.setBusy(name, busy, intended: intended)
    }

    /// Re-measures after content changes height (disclosure, banner).
    public func refreshSize() { resize() }

    /// Guidance text plus any command the user should run. Commands are shown as
    /// selectable text; the app never executes them.
    private func applyGuidance(_ snapshot: ProxySnapshot) {
        var guidance: String?
        var command: String?

        switch snapshot.nextAction {
        case .none:
            // A running-but-at-risk proxy still has advice worth surfacing.
            if case .running = snapshot.state, let recommended = snapshot.recommendedCommand {
                guidance = "Recommended:"
                command = recommended
            }
        case .runCommand(let value):
            guidance = "Start it again with:"
            command = value
        case .addAPIKey:
            guidance = "This proxy is bound to a non-loopback address and needs a key."
        case .retry:
            guidance = snapshot.dataAge.map { "Showing data from \(Format.age($0)). Retrying automatically." }
                ?? "Retrying automatically."
        }

        guidanceLabel.isHidden = guidance == nil
        guidanceLabel.stringValue = guidance ?? ""
        commandField.isHidden = command == nil
        commandField.stringValue = command ?? ""
        if let command {
            commandField.setAccessibilityLabel("Command to run: \(command)")
        }
    }

    private func applyActions(_ snapshot: ProxySnapshot, isLoading: Bool) {
        // Nothing is actionable before the first read completes.
        dashboardButton.isEnabled = !isLoading
        overflowButton.isEnabled = !isLoading
        stopButton.isEnabled = snapshot.state.isRunning
        stopButton.isHidden = !snapshot.state.isRunning

        switch snapshot.nextAction {
        case .addAPIKey:
            primaryButton.isHidden = false
            primaryButton.title = "Add key…"
            primaryButton.keyEquivalent = "\r"
        case .retry:
            primaryButton.isHidden = false
            primaryButton.title = "Retry"
            primaryButton.keyEquivalent = "\r"
        case .none, .runCommand:
            primaryButton.isHidden = true
            primaryButton.keyEquivalent = ""
        }
    }

    private func resize() {
        view.layoutSubtreeIfNeeded()
        let bodyHeight = ceil(body.fittingSize.height)
        // Chrome is the header, separator, action row, and insets.
        let chrome = ceil(header.fittingSize.height) + Theme.gutter * 2 + Theme.rowGap * 3 + 28
        let natural = chrome + bodyHeight
        let capped = min(Self.maxHeight, natural)
        // Scrollers appear only when the content genuinely overflows; a scroll bar on a
        // three-line loading state reads as a broken layout.
        let overflowing = natural > Self.maxHeight
        scrollView.hasVerticalScroller = overflowing
        scrollHeight?.constant = max(0, capped - chrome)
        preferredContentSize = NSSize(width: Theme.width, height: max(96, capped))
    }

    // MARK: - Actions

    @objc private func dashboardTapped() { onDashboard?() }
    @objc private func stopTapped() { onStop?() }
    @objc private func primaryTapped() {
        switch snapshot?.nextAction {
        case .addAPIKey: onAddKey?()
        case .retry: onRetry?()
        default: break
        }
    }
    @objc private func refreshTapped() { onRefresh?() }
    @objc private func quitTapped() { onQuit?() }

    @objc private func overflowTapped() {
        let menu = NSMenu()
        menu.addItem(withTitle: "Refresh", action: #selector(refreshTapped), keyEquivalent: "r").target = self
        menu.addItem(withTitle: "Open dashboard", action: #selector(dashboardTapped), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Companion settings…", action: #selector(companionSettingsTapped), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit OpenCodex", action: #selector(quitTapped), keyEquivalent: "q").target = self
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: overflowButton.bounds.height + 4), in: overflowButton)
    }
    @objc private func companionSettingsTapped() { onCompanionSettings?() }

    /// AppKit routes Escape here for the whole responder chain, which `keyDown` does not
    /// reliably receive inside a popover.
    public override func cancelOperation(_ sender: Any?) {
        view.window?.performClose(nil)
    }
}

/// Top-anchored clip view. AppKit scroll views are bottom-origin by default.
final class FlippedClipView: NSClipView {
    override var isFlipped: Bool { true }
}

/// Loading structure: grey bars where values will appear, so the first paint shows the
/// shape of the answer instead of empty space or a spinner.
final class SkeletonView: NSView {
    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: 84)
    }

    override func draw(_ dirtyRect: NSRect) {
        Theme.raised.setFill()
        let widths: [CGFloat] = [72, 0, 96, 140, 120, 110]
        var y = bounds.maxY - 12
        for width in widths {
            guard width > 0 else { y -= 8; continue }
            let rect = NSRect(x: 0, y: y, width: width, height: 9)
            NSBezierPath(roundedRect: rect, xRadius: 3, yRadius: 3).fill()
            y -= 15
        }
    }
}
