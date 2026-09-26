import SwiftUI
import Charts

struct NativeTrayProviderView: View {
    let provider: NativeTrayProvider
    var pendingSwitch: String? = nil
    var onUse: ((NativeTrayProvider.Account) -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                NativeTrayProviderMark(provider: provider)
                Text(provider.label).font(.subheadline.weight(.semibold))
            }
            if provider.unavailable || provider.accounts.isEmpty {
                Text(provider.unavailable ? "Account limits unavailable" : "No quota data")
                    .font(.caption).foregroundStyle(.secondary)
            }
            ForEach(provider.accounts) { account in
                VStack(alignment: .leading, spacing: 6) {
                    NativeTrayAccountHeader(
                        account: account,
                        switchable: provider.switchable == true && onUse != nil,
                        pending: pendingSwitch == account.id,
                        busy: pendingSwitch != nil,
                        onUse: { onUse?(account) })
                    if let email = account.email, email != account.label {
                        Text(email).font(.caption2).foregroundStyle(.secondary)
                    }
                    if account.unavailable || account.windows.isEmpty {
                        Text("No quota data").font(.caption2).foregroundStyle(.secondary)
                    }
                    ForEach(account.windows) { window in
                        HStack(spacing: 8) {
                            Text(window.label).lineLimit(1).frame(width: 96, alignment: .leading)
                            Text(NativeTrayFormat.percentText(window.value))
                                .monospacedDigit().frame(width: 36, alignment: .trailing)
                            NativeTrayQuotaBar(window: window)
                            Text(NativeTrayFormat.reset(window.resetAt)).monospacedDigit()
                                .frame(width: 70, alignment: .trailing)
                                .help(window.resetDate?.formatted(date: .complete, time: .standard) ?? "Reset time unavailable")
                        }.font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct NativeTrayChartView: View {
    let chart: NativeTrayChart
    let style: String
    private let palette: [Color] = [.blue, .orange, .green, .purple, .red, .cyan, .pink, .yellow, .mint, .indigo]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if chart.series.isEmpty {
                Text("No usage measurements").foregroundStyle(.secondary)
            } else {
                Chart {
                    ForEach(chart.series) { series in
                        ForEach(Array(series.points.enumerated()), id: \.offset) { index, point in
                            let date = Date(timeIntervalSince1970: chart.start + Double(index) * chart.bucketSeconds)
                            if style == "stackedBar" {
                                BarMark(x: .value("Time", date), y: .value("Tokens", max(0, point)), stacking: .standard)
                                    .foregroundStyle(by: .value("Series", series.id))
                            } else {
                                LineMark(x: .value("Time", date), y: .value("Tokens", max(0, point)), series: .value("Series", series.id))
                                    .foregroundStyle(by: .value("Series", series.id))
                            }
                        }
                    }
                }
                .chartYAxis {
                    AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { axis in
                        AxisGridLine()
                        AxisValueLabel(anchor: .trailing) {
                            if let value = axis.as(Double.self) { Text(NativeTrayFormat.tokens(value)) }
                        }
                    }
                }
                .chartXAxis {
                    AxisMarks(values: .automatic(desiredCount: 3)) { axis in
                        AxisGridLine()
                        AxisTick()
                        AxisValueLabel(anchor: .center) {
                            if let date = axis.as(Date.self) {
                                Text(date, format: .dateTime.hour().minute())
                            }
                        }
                    }
                }
                .chartForegroundStyleScale(domain: chart.series.map(\.id), range: chart.series.indices.map { palette[$0 % palette.count] })
                .chartLegend(.hidden)
                .frame(height: 130)
                .accessibilityLabel("Usage timeline")
                LazyVGrid(columns: [GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading)], alignment: .leading, spacing: 5) {
                    ForEach(Array(chart.series.enumerated()), id: \.element.id) { index, series in
                        HStack(spacing: 5) {
                            Circle().fill(palette[index % palette.count]).frame(width: 6, height: 6).accessibilityHidden(true)
                            Text(series.label).lineLimit(1).truncationMode(.middle).help(series.label)
                        }.font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
            if chart.incomplete {
                Text("Some usage records are unavailable").font(.caption2).foregroundStyle(.secondary)
            }
        }
    }
}
