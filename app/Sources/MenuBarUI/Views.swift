import AppKit
import MenuBarCore

// MARK: - Shared helpers

func makeLabel(_ text: String, font: NSFont, color: NSColor) -> NSTextField {
    let field = NSTextField(labelWithString: text)
    field.font = font
    field.textColor = color
    field.lineBreakMode = .byTruncatingTail
    return field
}

func makeRow(_ views: [NSView], spacing: CGFloat = Theme.rowGap) -> NSStackView {
    let stack = NSStackView(views: views)
    stack.orientation = .horizontal
    stack.spacing = spacing
    stack.alignment = .firstBaseline
    return stack
}

func makeSeparator() -> NSView {
    let line = NSView()
    line.wantsLayer = true
    line.layer?.backgroundColor = Theme.separator.cgColor
    line.translatesAutoresizingMaskIntoConstraints = false
    line.heightAnchor.constraint(equalToConstant: 1).isActive = true
    return line
}

// MARK: - Status header

/// `● Running          127.0.0.1:10100`
///
/// The dot never travels alone: the word beside it carries the same meaning, so the UI
/// stays readable without colour perception (WCAG 1.4.1).
final class StatusHeaderView: NSView {
    private let dot = StatusDotView()
    private let title = makeLabel("", font: Theme.label, color: Theme.text)
    private let endpoint = makeLabel("", font: Theme.caption, color: Theme.muted)
    private let detail = makeLabel("", font: Theme.caption, color: Theme.muted)

    init() {
        super.init(frame: .zero)
        let top = makeRow([dot, title, NSView(), endpoint], spacing: Theme.rowGap)
        top.alignment = .centerY
        top.distribution = .fill
        endpoint.setContentHuggingPriority(.defaultHigh, for: .horizontal)

        let stack = NSStackView(views: [top, detail])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 2
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { nil }

    func apply(_ snapshot: ProxySnapshot) {
        let state = snapshot.state
        title.stringValue = state.title
        endpoint.stringValue = snapshot.endpoint.display
        dot.tone = bridge(state.tone)

        if let text = state.detail {
            detail.stringValue = text
            detail.isHidden = false
        } else {
            detail.isHidden = true
        }

        setAccessibilityLabel("Proxy \(state.title) at \(snapshot.endpoint.display)")
    }

    private func bridge(_ tone: ProxyState.Tone) -> ProxyToneBridge {
        switch tone {
        case .neutral: return .neutral
        case .good: return .good
        case .warning: return .warning
        case .bad: return .bad
        }
    }
}

final class StatusDotView: NSView {
    var tone: ProxyToneBridge = .neutral {
        didSet { needsDisplay = true }
    }

    override var intrinsicContentSize: NSSize { NSSize(width: 8, height: 8) }

    override func draw(_ dirtyRect: NSRect) {
        let rect = NSRect(x: 0, y: (bounds.height - 8) / 2, width: 8, height: 8)
        Theme.color(for: tone).setFill()
        NSBezierPath(ovalIn: rect).fill()
    }
}

// MARK: - Metrics

/// Three columns plus a range header that echoes the response, never the request.
final class MetricsView: NSView {
    private let rangeLabel = makeLabel("USAGE", font: Theme.micro, color: Theme.faint)
    private let columns: [(caption: NSTextField, value: NSTextField)]
    private let emptyLabel = makeLabel("", font: Theme.caption, color: Theme.muted)
    private let stack: NSStackView
    private let columnsRow: NSStackView

    init() {
        let captions = ["REQUESTS", "TOKENS", "COST"]
        columns = captions.map { caption in
            (makeLabel(caption, font: Theme.micro, color: Theme.faint),
             makeLabel(Format.unknown, font: Theme.numeric, color: Theme.text))
        }

        let columnViews: [NSView] = columns.map { pair in
            let column = NSStackView(views: [pair.caption, pair.value])
            column.orientation = .vertical
            column.alignment = .leading
            column.spacing = 1
            return column
        }
        columnsRow = NSStackView(views: columnViews)
        columnsRow.orientation = .horizontal
        columnsRow.distribution = .fillEqually
        columnsRow.alignment = .top

        stack = NSStackView(views: [rangeLabel, columnsRow, emptyLabel])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = Theme.tightGap

        super.init(frame: .zero)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { nil }

    func apply(_ snapshot: ProxySnapshot) {
        let usage = snapshot.today ?? snapshot.usage
        isHidden = !snapshot.settings.showToday
        rangeLabel.stringValue = usage?.rangeLabel ?? "USAGE"
        columnsRow.arrangedSubviews[2].isHidden = !snapshot.settings.showCost

        // Three states: known-empty gets copy, unknown gets em dashes, data gets values.
        switch snapshot.usageIsEmpty {
        case .some(true):
            columnsRow.isHidden = true
            emptyLabel.isHidden = false
            emptyLabel.stringValue = "No requests in this period."
        default:
            columnsRow.isHidden = false
            emptyLabel.isHidden = true
            let summary = usage?.summary
            let requests = Format.count(summary?.requests)
            columns[0].value.stringValue = (summary?.hasEstimates ?? false) ? requests + "~" : requests
            columns[1].value.stringValue = Format.tokens(summary?.totalTokens)
            columns[2].value.stringValue = Format.cost(summary?.estimatedCostUsd)
            columns[0].value.setAccessibilityLabel(
                (summary?.hasEstimates ?? false)
                    ? "\(requests) requests, partly estimated"
                    : "\(requests) requests"
            )
        }
    }
}

// MARK: - Quotas

/// `OpenAI          ▓▓▓▓▓░░░░░  44%`
final class QuotaRowView: NSView {
    init(quota: NormalizedQuota) {
        super.init(frame: .zero)

        let name = makeLabel(quota.providerLabel, font: Theme.caption, color: Theme.text)
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        name.lineBreakMode = .byTruncatingTail

        // Which window a number belongs to is not decoration: 42% of an API-usage window
        // and 42% of a month mean very different things.
        let window = makeLabel(
            quota.hasPercent ? quota.windowLabel : "",
            font: Theme.micro, color: Theme.faint
        )

        let labels = NSStackView(views: [name, window])
        labels.orientation = .vertical
        labels.alignment = .leading
        labels.spacing = 0

        let bar = QuotaBarView()
        bar.percent = quota.percent

        let value = makeLabel(Format.percent(quota.percent), font: Theme.numericSmall, color: Theme.muted)
        value.alignment = .right

        let row = NSStackView(views: [labels, bar, value])
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
            labels.widthAnchor.constraint(equalToConstant: 132),
            value.widthAnchor.constraint(equalToConstant: 36),
        ])

        // The percentage is spoken, not merely drawn as a filled width.
        let reset = Format.resetsIn(quota.resetAt)
        setAccessibilityLabel(
            quota.hasPercent
                ? "\(quota.providerLabel): \(Format.percent(quota.percent)) of \(quota.windowLabel) quota, resets in \(reset)"
                : "\(quota.providerLabel): quota unknown"
        )
    }

    required init?(coder: NSCoder) { nil }
}

final class QuotaBarView: NSView {
    var percent: Double?

    override var intrinsicContentSize: NSSize { NSSize(width: 110, height: 6) }

    override func draw(_ dirtyRect: NSRect) {
        let track = NSRect(x: 0, y: (bounds.height - 6) / 2, width: bounds.width, height: 6)
        Theme.raised.setFill()
        NSBezierPath(roundedRect: track, xRadius: 3, yRadius: 3).fill()

        // A nil percent draws no fill at all — a zero-width bar would read as "0% used",
        // which is a different fact from "unknown".
        guard let percent else { return }
        let clamped = max(0, min(100, percent))
        guard clamped > 0 else { return }
        let fill = NSRect(x: 0, y: track.origin.y, width: track.width * CGFloat(clamped / 100), height: 6)
        Theme.quotaColor(percent: percent).setFill()
        NSBezierPath(roundedRect: fill, xRadius: 3, yRadius: 3).fill()
    }
}
