import SwiftUI
import WidgetKit
import MenuBarCore

struct OpenCodexWidgetView: View {
    let entry: SnapshotEntry
    @Environment(\.widgetFamily) private var family
    @Environment(\.widgetRenderingMode) private var renderingMode

    var body: some View {
        Group {
            if let failure = entry.failure {
                failureView(failure)
            } else if let snapshot = entry.snapshot {
                content(snapshot)
            } else {
                failureView(.missing)
            }
        }
        .containerBackground(.background, for: .widget)
        .widgetURL(widgetURL)
    }

    private var widgetURL: URL? {
        guard let display = entry.snapshot?.endpointDisplay,
              let endpoint = URL(string: "http://\(display)"),
              endpoint.host != nil, endpoint.port != nil
        else { return nil }
        return URL(string: "http://\(display)/#/usage")
    }

    @ViewBuilder
    private func content(_ snapshot: WidgetSnapshot) -> some View {
        switch family {
        case .systemSmall:
            small(snapshot)
        case .systemLarge:
            large(snapshot)
        default:
            medium(snapshot)
        }
    }

    private func tone(_ snapshot: WidgetSnapshot) -> Color {
        switch snapshot.state {
        case "running": return .green
        case "degraded": return .orange
        case "unreachable", "unauthorized": return .red
        default: return .secondary
        }
    }

    private func small(_ snapshot: WidgetSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 5) {
                Circle().fill(tone(snapshot)).frame(width: 7, height: 7)
                Text("OpenCodex").font(.caption).foregroundStyle(.secondary)
            }
            Text(Format.tokens(snapshot.today?.totalTokens))
                .font(.system(size: 28, weight: .semibold, design: .rounded))
                .lineLimit(1)
                .widgetAccentable()
            Text("tokens today").font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 4) {
                Text("\(Format.count(snapshot.today?.requests)) req")
                if let cost = snapshot.today?.estimatedCostUsd {
                    Text("·")
                    Text(Format.cost(cost))
                }
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            updated(snapshot)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func medium(_ snapshot: WidgetSnapshot) -> some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 5) {
                status(snapshot)
                metric("Tokens", Format.tokens(snapshot.today?.totalTokens))
                metric("Requests", Format.count(snapshot.today?.requests))
                if let cost = snapshot.today?.estimatedCostUsd { metric("Cost", Format.cost(cost)) }
                updated(snapshot)
            }
            Divider()
            if hasQuota(snapshot) {
                quotaView(snapshot)
            } else if let chart = snapshot.chart {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Last \(windowLabel(chart))\(chart.incomplete == true ? " · partial" : "")").font(.caption).foregroundStyle(.secondary)
                    chartView(chart, flexible: false).widgetAccentable()
                }
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    Text("No quota sources").font(.caption).foregroundStyle(.secondary)
                    Text("Quota appears for providers that report limits")
                        .font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func large(_ snapshot: WidgetSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            status(snapshot)
            metricsRow(snapshot)
            if !snapshot.quotas.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(Array(snapshot.quotas.prefix(4).enumerated()), id: \.offset) { _, quota in
                        quotaRow(quota)
                    }
                }
            }
            if let chart = snapshot.chart {
                Text("Last \(windowLabel(chart)) · \(chart.series.count) models\(chart.incomplete == true ? " · partial" : "")")
                    .font(.caption).foregroundStyle(.secondary)
                chartView(chart, flexible: true)
                    .frame(maxHeight: .infinity)
                    .widgetAccentable()
                legend(chart)
            }
            updated(snapshot)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func status(_ snapshot: WidgetSnapshot) -> some View {
        HStack(spacing: 5) {
            Circle().fill(tone(snapshot)).frame(width: 7, height: 7)
            Text(([snapshot.stateTitle, snapshot.detail].compactMap { $0?.isEmpty == false ? $0 : nil }).joined(separator: " · "))
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }

    private func metric(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Spacer()
            Text(value).font(.system(.body, design: .monospaced))
        }
    }

    private func metricsRow(_ snapshot: WidgetSnapshot) -> some View {
        HStack(spacing: 10) {
            metricColumn("TOKENS", Format.tokens(snapshot.today?.totalTokens))
            metricColumn("REQUESTS", Format.count(snapshot.today?.requests))
            metricColumn("COST", Format.cost(snapshot.today?.estimatedCostUsd))
        }
    }

    private func metricColumn(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption2).foregroundStyle(.secondary)
            Text(value).font(.system(.body, design: .monospaced)).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func hasQuota(_ snapshot: WidgetSnapshot) -> Bool {
        snapshot.quotas.contains { $0.percent != nil }
    }

    private func quotaView(_ snapshot: WidgetSnapshot) -> some View {
        Group {
            if let quota = snapshot.quotas.compactMap({ $0.percent == nil ? nil : $0 }).min(by: { ($0.percent ?? 100) < ($1.percent ?? 100) }) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(quota.providerLabel).font(.caption).lineLimit(1)
                    ProgressView(value: (quota.percent ?? 0) / 100)
                        .tint((quota.percent ?? 0) > 80 ? .orange : .green)
                    Text("\(quota.windowLabel) · \(resets(in: quota.resetAt))")
                        .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
            } else {
                Text("No quota sources").font(.caption).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func quotaRow(_ quota: WidgetSnapshot.Quota) -> some View {
        HStack {
            Text(quota.providerLabel).lineLimit(1)
            Spacer()
            Text("\(Format.percent(quota.percent)) · \(quota.windowLabel)")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func chartView(_ chart: WidgetSnapshot.Chart, flexible: Bool) -> some View {
        GeometryReader { geometry in
            if chart.style == "stackedBar" {
                stackedBars(chart, in: geometry.size)
            } else {
                lineChart(chart, in: geometry.size)
            }
        }
        .frame(minHeight: 72, maxHeight: flexible ? .infinity : 72)
    }

    private func legend(_ chart: WidgetSnapshot.Chart) -> some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], alignment: .leading, spacing: 4) {
            ForEach(Array(chart.series.prefix(5).enumerated()), id: \.offset) { index, series in
                HStack(spacing: 4) {
                    Circle().fill(seriesColor(index)).frame(width: 6, height: 6)
                    Text(series.id)
                        .font(.caption2)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
        }
    }

    private func lineChart(_ chart: WidgetSnapshot.Chart, in size: CGSize) -> some View {
        ZStack {
            ForEach(Array(chart.series.enumerated()), id: \.offset) { index, series in
                Path { path in
                    let maxValue = maxPoint(chart.series.flatMap(\.points))
                    for pointIndex in series.points.indices {
                        let x = series.points.count > 1
                            ? size.width * CGFloat(pointIndex) / CGFloat(series.points.count - 1) : 0
                        let y = size.height * (1 - CGFloat(series.points[pointIndex] / maxValue))
                        if pointIndex == 0 { path.move(to: CGPoint(x: x, y: y)) }
                        else { path.addLine(to: CGPoint(x: x, y: y)) }
                    }
                }
                .stroke(seriesColor(index), lineWidth: 1.5)
            }
        }
    }

    private func stackedBars(_ chart: WidgetSnapshot.Chart, in size: CGSize) -> some View {
        let count = chart.series.map(\.points.count).max() ?? 0
        let maxValue = maxPoint((0..<count).map { index in
            chart.series.reduce(0) { $0 + ($1.points.indices.contains(index) ? $1.points[index] : 0) }
        })
        return HStack(alignment: .bottom, spacing: 1) {
            ForEach(0..<count, id: \.self) { index in
                VStack(spacing: 0) {
                    ForEach(Array(chart.series.enumerated()), id: \.offset) { seriesIndex, series in
                        let value = series.points.indices.contains(index) ? series.points[index] : 0
                        Rectangle()
                            .fill(seriesColor(seriesIndex))
                            .frame(height: max(0, size.height * value / maxValue))
                    }
                }
            }
        }
    }

    private let palette: [Color] = [
        Color(red: 10 / 255, green: 132 / 255, blue: 1),
        Color(red: 1, green: 159 / 255, blue: 10 / 255),
        Color(red: 48 / 255, green: 209 / 255, blue: 88 / 255),
        Color(red: 191 / 255, green: 90 / 255, blue: 242 / 255),
        Color(red: 1, green: 69 / 255, blue: 58 / 255),
        Color(red: 100 / 255, green: 210 / 255, blue: 1)
    ]

    private func seriesColor(_ index: Int) -> Color {
        if renderingMode == .accented {
            return .primary.opacity([1, 0.8, 0.6, 0.45, 0.3, 0.2][index % 6])
        }
        return palette[index % palette.count]
    }

    private func windowLabel(_ chart: WidgetSnapshot.Chart) -> String {
        let hours = chart.bucketSeconds * (chart.series.map(\.points.count).max() ?? 0) / 3600
        if hours < 48 { return "\(hours)h" }
        return "\(hours / 24)d"
    }

    private func maxPoint(_ points: [Double]) -> Double { max(points.max() ?? 1, 1) }

    private func resets(in timestamp: Double?) -> String {
        Format.resetsIn(timestamp.map(Date.init(timeIntervalSince1970:)))
    }

    private func updated(_ snapshot: WidgetSnapshot) -> some View {
        let text = snapshot.lastUpdated.map { "Updated \(Format.age(Date(timeIntervalSince1970: $0)))" } ?? "Not updated"
        return Text(text).font(.caption2).foregroundStyle(entry.stale ? .orange : .secondary).lineLimit(1)
    }

    private func failureView(_ failure: ReadFailure) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: failure == .missing ? "rectangle.on.rectangle" : "exclamationmark.triangle")
                .font(.title2)
            Text(failure == .missing
                 ? "Open the OpenCodex desktop app to start sharing usage."
                 : "Snapshot unreadable — refresh from the desktop app.")
                .font(.caption)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

@main
struct OpenCodexWidgetBundle: WidgetBundle {
    var body: some Widget {
        OpenCodexWidget()
    }
}

struct OpenCodexWidget: Widget {
    let kind = "OpenCodexWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: SnapshotProvider()) { entry in
            OpenCodexWidgetView(entry: entry)
        }
        .configurationDisplayName("OpenCodex")
        .description("Proxy status, today's usage, and quota at a glance.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}
