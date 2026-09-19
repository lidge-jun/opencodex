import AppKit
import MenuBarCore

final class ModelsListView: NSView {
    private let stack = NSStackView()
    private let caption = makeLabel("MODELS", font: Theme.micro, color: Theme.faint)

    init() {
        super.init(frame: .zero)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = Theme.tightGap
        stack.addArrangedSubview(caption)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor), stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor), stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { nil }

    func apply(_ snapshot: ProxySnapshot) {
        clearRows()
        let rows = snapshot.todayRows.sorted { ($0.totalTokens ?? 0) > ($1.totalTokens ?? 0) }.prefix(5)
        isHidden = !snapshot.settings.showModels || rows.isEmpty
        for row in rows {
            let model = [row.provider, row.model].compactMap { $0 }.joined(separator: "/")
            let cost = snapshot.settings.showCost ? " · \(Format.cost(row.estimatedCostUsd))" : ""
            stack.addArrangedSubview(makeLabel(
                "\(model) · \(Format.count(row.requests)) · \(Format.tokens(row.totalTokens))\(cost)",
                font: Theme.caption, color: Theme.text
            ))
        }
    }

    private func clearRows() {
        for view in stack.arrangedSubviews.dropFirst() { stack.removeArrangedSubview(view); view.removeFromSuperview() }
    }
}

final class AccountsListView: NSView {
    private let stack = NSStackView()
    private let caption = makeLabel("ACCOUNTS", font: Theme.micro, color: Theme.faint)

    init() {
        super.init(frame: .zero)
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = Theme.tightGap
        stack.addArrangedSubview(caption)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor), stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor), stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { nil }

    func apply(_ snapshot: ProxySnapshot) {
        clearRows()
        let rows = (snapshot.today?.accounts ?? []).sorted { ($0.totalTokens ?? 0) > ($1.totalTokens ?? 0) }
        isHidden = !snapshot.settings.showAccounts || rows.isEmpty
        for row in rows {
            stack.addArrangedSubview(makeLabel(
                "\(row.accountLogLabel ?? Format.unknown) · \(Format.count(row.requests)) · \(Format.tokens(row.totalTokens))",
                font: Theme.caption, color: Theme.text
            ))
        }
    }

    private func clearRows() {
        for view in stack.arrangedSubviews.dropFirst() { stack.removeArrangedSubview(view); view.removeFromSuperview() }
    }
}
