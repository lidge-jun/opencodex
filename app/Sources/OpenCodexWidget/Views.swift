import SwiftUI
import WidgetKit
import MenuBarCore

@available(macOS 14, *)
struct OpenCodexWidgetView: View {
    let entry: SnapshotEntry
    @Environment(\.widgetFamily) private var family

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
            Text(Format.count(snapshot.today?.requests))
                .font(.system(size: 28, weight: .semibold, design: .rounded))
                .lineLimit(1)
            if let title = snapshot.menuTitle {
                Text(title).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            } else {
                Text("requests today").font(.caption).foregroundStyle(.secondary)
            }
            updated(snapshot)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func medium(_ snapshot: WidgetSnapshot) -> some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 5) {
                status(snapshot)
                metric("Requests", Format.count(snapshot.today?.requests))
                metric("Tokens", Format.tokens(snapshot.today?.totalTokens))
                if let cost = snapshot.today?.estimatedCostUsd { metric("Cost", Format.cost(cost)) }
                updated(snapshot)
            }
            Divider()
            quotaView(snapshot)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func large(_ snapshot: WidgetSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            medium(snapshot)
            if let chart = snapshot.chart { chartView(chart) }
            ForEach(Array(snapshot.quotas.prefix(4).enumerated()), id: \.offset) { _, quota in
                quotaRow(quota)
            }
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

    private func chartView(_ chart: WidgetSnapshot.Chart) -> some View {
        GeometryReader { geometry in
            if chart.style == "stackedBar" {
                stackedBars(chart, in: geometry.size)
            } else {
                lineChart(chart, in: geometry.size)
            }
        }
        .frame(height: 72)
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
                .stroke(palette[index % palette.count], lineWidth: 1.5)
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
                            .fill(palette[seriesIndex % palette.count])
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
                 ? "Open the OpenCodex menu bar app to start sharing usage."
                 : "Snapshot unreadable — refresh from the menu bar app.")
                .font(.caption)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

@available(macOS 14, *)
struct OpenCodexWidgetBundle: WidgetBundle {
    var body: some Widget {
        OpenCodexWidget()
    }
}

@available(macOS 14, *)
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
