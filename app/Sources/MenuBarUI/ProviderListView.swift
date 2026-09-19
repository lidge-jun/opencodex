import AppKit
import MenuBarCore

/// Collapsed provider list with per-provider enable/disable switches.
///
/// Collapsed by default: reading status is frequent, toggling a provider is rare, and
/// the urgency order in `003` puts actions below information.
public final class ProviderListView: NSView {
    private let disclosure = NSButton()
    private let summary = makeLabel("", font: Theme.caption, color: Theme.muted)
    private let rows = NSStackView()
    private var expanded = false
    private var snapshot: ProxySnapshot?
    /// Providers with a write in flight, mapped to the state the USER chose. A poll can
    /// still be carrying pre-write data, so the intended value — not the snapshot — is
    /// what a rebuilt row must show.
    private var pending: [String: Bool] = [:]

    /// `(provider, shouldDisable)`.
    public var onToggle: ((String, Bool) -> Void)?

    public override init(frame: NSRect) {
        super.init(frame: frame)

        disclosure.bezelStyle = .disclosure
        disclosure.setButtonType(.onOff)
        disclosure.title = ""
        disclosure.target = self
        disclosure.action = #selector(toggleExpanded)
        disclosure.setAccessibilityLabel("Show providers")

        rows.orientation = .vertical
        rows.alignment = .leading
        rows.spacing = Theme.tightGap
        rows.isHidden = true

        let header = NSStackView(views: [disclosure, summary])
        header.orientation = .horizontal
        header.spacing = Theme.tightGap
        header.alignment = .centerY

        let column = NSStackView(views: [header, rows])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = Theme.tightGap
        column.translatesAutoresizingMaskIntoConstraints = false
        addSubview(column)
        NSLayoutConstraint.activate([
            column.topAnchor.constraint(equalTo: topAnchor),
            column.leadingAnchor.constraint(equalTo: leadingAnchor),
            column.trailingAnchor.constraint(equalTo: trailingAnchor),
            column.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    public convenience init() { self.init(frame: .zero) }

    public required init?(coder: NSCoder) { nil }

    public func apply(_ snapshot: ProxySnapshot) {
        self.snapshot = snapshot

        guard snapshot.providersLoaded else {
            isHidden = true
            return
        }
        isHidden = false

        if snapshot.providers.isEmpty {
            summary.stringValue = "No providers configured."
            disclosure.isHidden = true
            rows.isHidden = true
            return
        }

        disclosure.isHidden = false
        let enabled = snapshot.providers.filter(\.isEnabled).count
        summary.stringValue = "\(enabled) of \(snapshot.providers.count) providers enabled"
        rebuildRows(snapshot)
        rows.isHidden = !expanded
    }

    private func rebuildRows(_ snapshot: ProxySnapshot) {
        for view in rows.arrangedSubviews {
            rows.removeArrangedSubview(view)
            view.removeFromSuperview()
        }

        for provider in snapshot.visibleProviders.sorted(by: { $0.name < $1.name }) {
            let isDefault = provider.name == snapshot.defaultProvider
            let row = ProviderRowView(
                provider: provider,
                isDefault: isDefault
            ) { [weak self] shouldDisable in
                self?.onToggle?(provider.name, shouldDisable)
            }
            // A refresh that lands mid-write must not undo the optimistic state: apply
            // the intended value first, then mark the row busy.
            if let intended = pending[provider.name] {
                row.setEnabled(intended)
                row.setBusy(true)
            }
            row.translatesAutoresizingMaskIntoConstraints = false
            rows.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: rows.widthAnchor).isActive = true
        }
    }

    /// Shared by the disclosure button and the test hook.
    func setExpanded(_ value: Bool) {
        expanded = value
        disclosure.state = value ? .on : .off
        rows.isHidden = !expanded
        disclosure.setAccessibilityLabel(expanded ? "Hide providers" : "Show providers")
        (window?.contentViewController as? PopoverViewController)?.refreshSize()
    }

    var providerRows: [NSView] { rows.arrangedSubviews }

    @objc private func toggleExpanded() {
        expanded = disclosure.state == .on
        rows.isHidden = !expanded
        disclosure.setAccessibilityLabel(expanded ? "Hide providers" : "Show providers")
        // The popover has to grow or shrink with the disclosure.
        (window?.contentViewController as? PopoverViewController)?.refreshSize()
    }

    /// Reverts a switch after the proxy rejected the change.
    public func revert(_ name: String, to enabled: Bool) {
        pending[name] = nil
        for case let row as ProviderRowView in rows.arrangedSubviews where row.providerName == name {
            row.setEnabled(enabled)
            row.setBusy(false)
        }
    }

    /// Marks a provider as having a write in flight. Its switch stays inert until the
    /// authoritative refresh lands, so a poll cannot resurrect the pre-toggle state and
    /// a second click cannot race the first.
    /// `intended` is the state the user selected, retained so a poll landing mid-write
    /// cannot snap the switch back.
    public func setBusy(_ name: String, _ busy: Bool, intended: Bool? = nil) {
        if busy {
            pending[name] = intended ?? pending[name] ?? true
        } else {
            pending[name] = nil
        }
        for case let row as ProviderRowView in rows.arrangedSubviews where row.providerName == name {
            if busy, let value = pending[name] { row.setEnabled(value) }
            row.setBusy(busy)
        }
    }
}

public final class ProviderRowView: NSView {
    public let providerName: String
    private let toggle = NSSwitch()
    private let onToggle: (Bool) -> Void
    private var baseEnabled = true
    private var isBusy = false

    init(provider: ProviderSummary, isDefault: Bool, onToggle: @escaping (Bool) -> Void) {
        self.providerName = provider.name
        self.onToggle = onToggle
        super.init(frame: .zero)

        let name = makeLabel(provider.name, font: Theme.caption, color: Theme.text)
        let detail = makeLabel(
            isDefault ? "default" : (provider.authMode ?? ""),
            font: Theme.micro,
            color: Theme.faint
        )

        let labels = NSStackView(views: [name, detail])
        labels.orientation = .vertical
        labels.alignment = .leading
        labels.spacing = 0

        toggle.state = provider.isEnabled ? .on : .off
        toggle.controlSize = .mini
        toggle.target = self
        toggle.action = #selector(switched)

        // The proxy rejects only DISABLING the default provider (`provider-routes.ts:178`
        // guards on `rawBody.disabled && name === defaultProvider`). Enabling it is
        // valid, so a default provider that is currently off must stay toggleable —
        // otherwise the app strands the user in a state it cannot leave.
        let wouldDisableDefault = isDefault && provider.isEnabled
        toggle.isEnabled = !wouldDisableDefault
        toggle.toolTip = wouldDisableDefault
            ? "This is the default provider. Choose another default in the dashboard first."
            : nil
        baseEnabled = toggle.isEnabled
        toggle.setAccessibilityLabel("\(provider.name) enabled")

        let row = NSStackView(views: [labels, NSView(), toggle])
        row.orientation = .horizontal
        row.spacing = Theme.rowGap
        row.alignment = .centerY
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: topAnchor),
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { nil }

    func setEnabled(_ enabled: Bool) { toggle.state = enabled ? .on : .off }

    var toggleState: Bool { toggle.state == .on }
    var toggleIsEnabled: Bool { toggle.isEnabled }

    /// Inert while its write is in flight, so a second click cannot race the first.
    func setBusy(_ busy: Bool) {
        isBusy = busy
        toggle.isEnabled = busy ? false : baseEnabled
        alphaValue = busy ? 0.6 : 1
    }

    @objc private func switched() {
        // Optimistic: the switch has already moved. The caller reverts on failure.
        onToggle(toggle.state == .off)
    }
}


// MARK: - Test inspection

/// Read-only hooks so the UI suite can assert on rendered control state rather than on
/// the view's private bookkeeping.
package extension ProviderListView {
    /// Expands the list without going through a click, so tests do not depend on
    /// NSButton action dispatch.
    func expandForTesting() { setExpanded(true) }

    func isToggleOn(_ name: String) -> Bool? { row(name)?.isOn }
    func isToggleEnabled(_ name: String) -> Bool? { row(name)?.isToggleEnabled }
    func hasProviderForTesting(_ name: String) -> Bool { row(name) != nil }

    private func row(_ name: String) -> ProviderRowView? {
        for case let row as ProviderRowView in providerRows where row.providerName == name {
            return row
        }
        return nil
    }
}

package extension ProviderRowView {
    var isOn: Bool { toggleState }
    var isToggleEnabled: Bool { toggleIsEnabled }
}
