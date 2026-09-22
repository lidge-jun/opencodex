import Foundation

/// Everything the UI can show, as one value.
///
/// Views are pure functions of this snapshot, so no view invents its own loading flag or
/// decides independently whether data is missing.
public enum ProxyState: Equatable, Sendable {
    /// First fetch in flight; nothing is known yet.
    case loading
    case running(StartupHealth)
    /// Connection refused — the proxy is not running.
    case unreachable
    /// 401 with no usable credential.
    case unauthorized
    /// Reachable but erroring. The message is proxy-free human text.
    case degraded(String)

    public var isRunning: Bool {
        if case .running = self { return true }
        return false
    }

    /// Short label shown beside the status dot. Colour is never the only carrier of
    /// meaning, so every state has a word.
    public var title: String {
        switch self {
        case .loading: return "Checking…"
        case .running: return "Running"
        case .unreachable: return "Stopped"
        case .unauthorized: return "Needs API key"
        case .degraded: return "Degraded"
        }
    }

    public enum Tone: Sendable { case neutral, good, warning, bad }

    public var tone: Tone {
        switch self {
        case .loading: return .neutral
        case .running(let health): return health.isProtected ? .good : .warning
        case .unreachable: return .bad
        case .unauthorized: return .warning
        case .degraded: return .warning
        }
    }

    /// Secondary line under the title.
    public var detail: String? {
        switch self {
        case .loading:
            return nil
        case .running(let health):
            let parts = [health.status, health.protection]
                .compactMap { $0 }
                .filter { !$0.isEmpty && $0 != "none" }
            return parts.isEmpty ? nil : parts.joined(separator: " · ")
        case .unreachable:
            return "The proxy is not running."
        case .unauthorized:
            return "This proxy requires an API key."
        case .degraded(let message):
            return message
        }
    }
}

/// What the user should do next. `loading` deliberately has none — there is nothing to
/// act on yet — but every other non-running state names one.
public enum NextAction: Equatable, Sendable {
    case none
    /// A command to run, shown as selectable text. The app never spawns processes.
    case runCommand(String)
    case addAPIKey
    case retry
}

public struct ProxySnapshot: Equatable, Sendable {
    public var state: ProxyState
    public var endpoint: ProxyEndpoint
    public var usage: UsageReport?
    public var settings: CompanionSettings
    public var settingsLoaded: Bool
    public var today: UsageReport?
    public var timeline: UsageTimeline?
    public var timelineUpdated: Date?
    public var quotas: [QuotaReport]
    public var providers: [ProviderSummary]
    public var defaultProvider: String?
    public var lastUpdated: Date?
    public var consecutiveFailures: Int
    /// Remembered from the last successful health read, so a stopped proxy can still
    /// tell the user the right start command for their install.
    public var lastKnownStartCommand: String?
    /// The proxy's own remediation hint (for example `ocx service install`). Displayed
    /// as selectable text, never executed.
    public var recommendedCommand: String?
    /// Whether a section has actually been read, so "not fetched yet" and "the proxy
    /// reported none" render differently.
    public var providersLoaded: Bool
    public var quotasLoaded: Bool
    /// When the aggregation data last succeeded, which is NOT when health last
    /// succeeded. Conflating them let a degraded state claim "showing data from 5s ago"
    /// while holding no metrics at all.
    public var usageUpdated: Date?

    public init(
        state: ProxyState = .loading,
        endpoint: ProxyEndpoint,
        usage: UsageReport? = nil,
        settings: CompanionSettings = .defaults,
        settingsLoaded: Bool = false,
        today: UsageReport? = nil,
        timeline: UsageTimeline? = nil,
        timelineUpdated: Date? = nil,
        quotas: [QuotaReport] = [],
        providers: [ProviderSummary] = [],
        defaultProvider: String? = nil,
        lastUpdated: Date? = nil,
        consecutiveFailures: Int = 0,
        lastKnownStartCommand: String? = nil,
        recommendedCommand: String? = nil,
        providersLoaded: Bool = false,
        quotasLoaded: Bool = false,
        usageUpdated: Date? = nil
    ) {
        self.state = state
        self.endpoint = endpoint
        self.usage = usage
        self.settings = settings
        self.settingsLoaded = settingsLoaded
        self.today = today
        self.timeline = timeline
        self.timelineUpdated = timelineUpdated
        self.quotas = quotas
        self.providers = providers
        self.defaultProvider = defaultProvider
        self.lastUpdated = lastUpdated
        self.consecutiveFailures = consecutiveFailures
        self.lastKnownStartCommand = lastKnownStartCommand
        self.recommendedCommand = recommendedCommand
        self.providersLoaded = providersLoaded
        self.quotasLoaded = quotasLoaded
        self.usageUpdated = usageUpdated
    }

    /// Whether the data sections are worth rendering at all.
    ///
    /// `degraded` keeps them: the plan requires stale-but-labelled over blank, because a
    /// user who can still see last-known numbers with an explicit age is better served
    /// than one staring at an empty panel.
    public var showsData: Bool {
        switch state {
        case .running: return true
        // Only claim stale data when data was actually loaded. Health succeeding while
        // the popover was closed is not the same as having metrics to show.
        case .degraded: return usage != nil || quotasLoaded
        case .loading, .unreachable, .unauthorized: return false
        }
    }

    /// Age of the DATA, not of the last health probe.
    public var dataAge: Date? { usageUpdated }

    /// True once the proxy has been read at least once, so `loading` can show skeletons
    /// rather than empty copy.
    public var hasEverLoaded: Bool { lastUpdated != nil }

    public var nextAction: NextAction {
        switch state {
        case .loading: return .none
        case .running: return .none
        case .unreachable:
            return .runCommand(lastKnownStartCommand ?? "ocx start")
        case .unauthorized: return .addAPIKey
        case .degraded: return .retry
        }
    }

    /// One normalized row per provider for the compact quota list.
    public var quotaRows: [NormalizedQuota] {
        quotas.filter { !settings.hiddenProviders.contains($0.provider) }.map { $0.normalized() }
    }

    public var visibleProviders: [ProviderSummary] {
        providers.filter { !settings.hiddenProviders.contains($0.name) }
    }

    public var menuBarTitle: String? {
        MenuBarTitle.render(settings: settings, today: today ?? usage, quotas: quotaRows)
    }

    public var todayRows: [UsageModelRow] { today?.models ?? [] }

    /// Whether the metrics section should render its empty copy. `nil` means unknown,
    /// which renders em dashes instead.
    public var usageIsEmpty: Bool? { usage?.isEmptyOrUnknown }

    public func canToggle(_ provider: ProviderSummary) -> Bool {
        provider.name != defaultProvider
    }
}
