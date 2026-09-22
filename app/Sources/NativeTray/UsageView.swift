import SwiftUI

@MainActor
final class NativeTrayStore: ObservableObject {
    @Published var snapshot: NativeTraySnapshot?
    @Published var decodeFailed = false
    var action: (Int32) -> Void = { _ in }
}

struct NativeTrayUsageView: View {
    @ObservedObject var store: NativeTrayStore

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("OpenCodex").font(.headline)
                Spacer()
                if store.snapshot?.refreshing == true { ProgressView().controlSize(.small) }
                Button { store.action(4) } label: { Image(systemName: "gearshape") }
                    .buttonStyle(.plain).help("Settings").accessibilityLabel("Settings")
            }.padding(14)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let snapshot = store.snapshot {
                        if snapshot.settings.showToday || snapshot.settings.show30Days {
                            HStack(alignment: .top, spacing: 16) {
                                if snapshot.settings.showToday {
                                    NativeTrayTotalsView(title: "Today", totals: snapshot.today, showCost: snapshot.settings.showCost)
                                }
                                if snapshot.settings.showToday && snapshot.settings.show30Days { Divider() }
                                if snapshot.settings.show30Days {
                                    NativeTrayTotalsView(title: "30 days", totals: snapshot.month, showCost: snapshot.settings.showCost)
                                }
                            }
                        }
                        if snapshot.settings.showChart, let chart = snapshot.chart {
                            Divider()
                            NativeTrayChartView(chart: chart, style: snapshot.settings.chartStyle)
                        }
                        if snapshot.settings.showModels && !snapshot.models.isEmpty {
                            Divider()
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Models").font(.subheadline).foregroundStyle(.secondary)
                                ForEach(snapshot.models) { row in
                                    HStack {
                                        Text(row.label).lineLimit(1).help(row.label)
                                        Spacer(minLength: 8)
                                        Text("\(NativeTrayFormat.tokens(row.requests)) requests")
                                            .foregroundStyle(.secondary).font(.caption)
                                        Text(NativeTrayFormat.tokens(row.tokens)).monospacedDigit()
                                    }
                                }
                            }
                        }
                        if snapshot.settings.showAccounts {
                            Divider()
                            ForEach(snapshot.providers) { provider in
                                NativeTrayProviderView(provider: provider)
                            }
                        }
                        ForEach(Array(snapshot.errors.enumerated()), id: \.offset) { _, error in
                            Label(error, systemImage: "exclamationmark.triangle")
                                .foregroundStyle(.secondary).font(.caption)
                        }
                    } else {
                        HStack { ProgressView().controlSize(.small); Text("Loading usage…") }
                            .frame(maxWidth: .infinity, alignment: .center).padding(.vertical, 40)
                    }
                    if store.decodeFailed {
                        Text("Usage data could not be read. Try refreshing.").foregroundStyle(.secondary)
                    }
                }.padding(14).frame(maxWidth: .infinity, alignment: .leading)
            }
            Divider()
            HStack(spacing: 10) {
                Button("Refresh") { store.action(1) }
                    .disabled(store.snapshot?.refreshing == true && !store.decodeFailed)
                if let updated = NativeTrayFormat.date(store.snapshot?.updatedAt) {
                    Text(updated, style: .time).font(.caption).foregroundStyle(.secondary)
                        .help("Last successful update")
                }
                Spacer()
                Button("Dashboard") { store.action(3) }
            }.controlSize(.small).padding(12)
        }
        .font(.system(size: 12))
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onExitCommand { store.action(2) }
    }
}

private struct NativeTrayTotalsView: View {
    let title: String
    let totals: NativeTrayTotals?
    let showCost: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title).font(.subheadline).foregroundStyle(.secondary)
            row("Total tokens", NativeTrayFormat.tokens(totals?.tokens), headline: true)
            row("Input", NativeTrayFormat.tokens(totals?.input))
            if let cached = totals?.cachedPercent {
                Text("\(Int(cached.rounded()))% cached").font(.caption2).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
            row("Output", NativeTrayFormat.tokens(totals?.output))
            if showCost {
                row("Cost · est.", (totals?.cost?.formatted(.currency(code: "USD")) ?? "—") + (totals?.costIncomplete == true ? "*" : ""))
                    .help(totals?.costIncomplete == true ? "Some requests have no price or usage. API list-price equivalent, not an actual charge." : "API list-price equivalent, not an actual charge")
            }
            row("Requests", NativeTrayFormat.tokens(totals?.requests))
            if let coverage = totals?.coverage, coverage < 100 { row("Coverage", "\(Int(coverage.rounded()))%") }
            if totals?.incomplete == true {
                Text("Some usage records are unavailable").font(.caption2).foregroundStyle(.secondary)
            }
        }.frame(maxWidth: .infinity, alignment: .topLeading)
    }
    private func row(_ label: String, _ value: String, headline: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).foregroundStyle(.secondary).font(.caption)
            Spacer(minLength: 4)
            Text(value).font(headline ? .system(size: 19, weight: .semibold, design: .rounded) : .system(size: 12))
                .monospacedDigit().lineLimit(1).minimumScaleFactor(0.8)
        }
    }
}
