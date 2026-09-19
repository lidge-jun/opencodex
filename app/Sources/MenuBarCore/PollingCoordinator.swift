import Foundation

/// Owns the refresh schedule and turns transport results into a `ProxySnapshot`.
///
/// Polling is deliberately conservative. A menu bar app that hits a local server every
/// five seconds forever is a battery complaint waiting to happen, so heavy aggregation
/// endpoints are fetched only while the popover is open, and repeated failures back the
/// liveness tick off rather than hammering a proxy the user has stopped on purpose.
public actor PollingCoordinator {
    public static let livenessInterval: TimeInterval = 5
    public static let heavyInterval: TimeInterval = 60
    public static let backoffInterval: TimeInterval = 30
    public static let backoffAfterFailures = 3

    private let client: ProxyClient
    private var snapshot: ProxySnapshot
    private var popoverOpen = false
    private var observers: [UUID: @Sendable (ProxySnapshot) -> Void] = [:]
    /// Rises on every close and on every new refresh, so results from a superseded or
    /// abandoned cycle can be discarded instead of overwriting fresher state.
    private var generation = 0
    private var refreshInFlight = false
    /// A refresh requested while another was in flight. Without this, closing and
    /// immediately reopening the popover dropped the reopen's refresh entirely: the old
    /// cycle exited on its generation guard and the new one had already been rejected.
    private var pendingOpenRefresh = false
    /// Continuations waiting for a cycle to publish. Waiting on a real completion signal
    /// rather than a bounded spin means a slow-but-legitimate refresh cannot be
    /// abandoned early, which would re-enable a control against pre-write state.
    private var completionWaiters: [CheckedContinuation<Void, Never>] = []
    /// Attempt time, distinct from success time: a persistently failing endpoint must
    /// not turn its healthy sibling into a 5-second poller.
    private var lastAggregationAttempt: Date?

    public init(client: ProxyClient, endpoint: ProxyEndpoint) {
        self.client = client
        self.snapshot = ProxySnapshot(endpoint: endpoint)
    }

    public var current: ProxySnapshot { snapshot }

    /// Interval until the next liveness tick, widened once failures pile up.
    public var currentInterval: TimeInterval {
        snapshot.consecutiveFailures >= Self.backoffAfterFailures
            ? Self.backoffInterval
            : Self.livenessInterval
    }

    @discardableResult
    public func observe(_ handler: @escaping @Sendable (ProxySnapshot) -> Void) -> UUID {
        let token = UUID()
        observers[token] = handler
        handler(snapshot)
        return token
    }

    public func removeObserver(_ token: UUID) { observers[token] = nil }

    public func setPopoverOpen(_ open: Bool) async {
        popoverOpen = open
        if open {
            await refresh(includeHeavy: true)
        } else {
            // Abandon in-flight heavy work: its results are no longer visible and
            // must not land as if they were current.
            generation &+= 1
        }
    }

    /// One refresh cycle.
    ///
    /// `includeHeavy` marks a popover-open refresh: on-open reads (providers, config)
    /// always run, while the expensive aggregation reads (usage, quotas) still respect
    /// the 60s interval so reopening the popover repeatedly does not hammer the proxy.
    public func refresh(includeHeavy: Bool = false) async {
        // Overlapping cycles publish interleaved state and double the request rate.
        guard !refreshInFlight else {
            if includeHeavy { pendingOpenRefresh = true }
            return
        }
        refreshInFlight = true
        generation &+= 1
        let cycle = generation
        defer { refreshInFlight = false }

        do {
            let health = try await client.health()
            guard cycle == generation else {
                refreshInFlight = false
                await drainPendingRefresh()
                signalCompletionIfIdle()
                return
            }
            snapshot.state = .running(health)
            snapshot.lastKnownStartCommand = health.manualStartCommand
            snapshot.recommendedCommand = health.recommendedCommand
            snapshot.consecutiveFailures = 0
            snapshot.lastUpdated = Date()
        } catch is CancellationError {
            // The popover closed mid-flight. Not a proxy failure; leave state untouched.
            refreshInFlight = false
            await drainPendingRefresh()
            signalCompletionIfIdle()
            return
        } catch let error as ProxyError {
            if cycle == generation { apply(error); publish() }
            refreshInFlight = false
            await drainPendingRefresh()
            signalCompletionIfIdle()
            return
        } catch {
            if cycle == generation { apply(.transport); publish() }
            refreshInFlight = false
            await drainPendingRefresh()
            signalCompletionIfIdle()
            return
        }

        if popoverOpen, includeHeavy {
            await refreshOnOpen(cycle: cycle)
        }

        // Settings and today metrics also drive the menu-bar title, so aggregation runs
        // on the normal cadence even while the popover is closed.
        let aggregationDue = lastAggregationAttempt.map {
            Date().timeIntervalSince($0) >= Self.heavyInterval
        } ?? true
        if aggregationDue, isCurrentCycle(cycle) {
            lastAggregationAttempt = Date()
            _ = await refreshAggregation(cycle: cycle)
        }

        if cycle == generation { publish() }
        refreshInFlight = false
        await drainPendingRefresh()
        signalCompletionIfIdle()
    }

    /// Refreshes and does not return until a cycle has actually published.
    ///
    /// `refresh()` coalesces: if another cycle holds the lock it queues and returns
    /// immediately. A caller that needs authoritative state afterwards — such as
    /// re-enabling a switch after a write — would otherwise act on pre-write data.
    public func refreshAndWait(includeHeavy: Bool = true) async {
        if refreshInFlight {
            // Queue behind the running cycle and wait for the queued one to finish.
            await refresh(includeHeavy: includeHeavy)
            await waitForCompletion()
            return
        }
        await refresh(includeHeavy: includeHeavy)
    }

    /// Number of callers currently suspended in `waitForCompletion()`.
    ///
    /// Exposed so a test can wait for registration deterministically instead of sleeping
    /// and hoping the waiter task was scheduled — a fixed sleep let the continuation
    /// tests pass without ever entering this path.
    package var waiterCount: Int { completionWaiters.count }

    private func waitForCompletion() async {
        guard refreshInFlight || pendingOpenRefresh else { return }
        await withCheckedContinuation { continuation in
            completionWaiters.append(continuation)
        }
    }

    /// Releases anyone waiting once no cycle is running or queued.
    private func signalCompletionIfIdle() {
        guard !refreshInFlight, !pendingOpenRefresh, !completionWaiters.isEmpty else { return }
        let waiters = completionWaiters
        completionWaiters.removeAll()
        for waiter in waiters { waiter.resume() }
    }

    /// Runs a refresh that arrived while another cycle held the lock.
    private func drainPendingRefresh() async {
        guard pendingOpenRefresh, popoverOpen else {
            pendingOpenRefresh = false
            return
        }
        pendingOpenRefresh = false
        await refresh(includeHeavy: true)
    }

    /// Reads that are only meaningful while the popover is open.
    private func refreshOnOpen(cycle: Int) async {
        guard isCurrent(cycle) else { return }
        if let providers = try? await client.providers(), isCurrent(cycle) {
            snapshot.providers = providers
            snapshot.providersLoaded = true
        }
        // Re-check before each subsequent request: closing mid-flight should stop the
        // sequence, not merely discard its results after paying for them.
        guard isCurrent(cycle) else { return }
        if let config = try? await client.config(), isCurrent(cycle) {
            snapshot.defaultProvider = config.defaultProvider
        }
    }

    /// Still the newest cycle, and still worth doing.
    private func isCurrent(_ cycle: Int) -> Bool { cycle == generation && popoverOpen }
    private func isCurrentCycle(_ cycle: Int) -> Bool { cycle == generation }

    /// The expensive aggregation reads. Returns whether every read landed, so a partial
    /// failure does not masquerade as a completed refresh.
    private func refreshAggregation(cycle: Int) async -> Bool {
        guard isCurrentCycle(cycle) else { return false }
        var complete = true

        // Each read is independent: one failing endpoint must not blank the others.
        if let response = try? await client.companionSettings() {
            guard isCurrentCycle(cycle) else { return false }
            snapshot.settings = response.settings
            snapshot.settingsLoaded = true
        } else {
            complete = false
        }

        guard isCurrentCycle(cycle) else { return false }
        if let today = try? await client.usage(range: .today) {
            guard isCurrentCycle(cycle) else { return false }
            snapshot.today = today
            snapshot.usage = today
            snapshot.usageUpdated = Date()
        } else {
            complete = false
        }

        guard isCurrentCycle(cycle) else { return false }
        if snapshot.settings.showChart, let timeline = try? await client.timeline(snapshot.settings) {
            guard isCurrentCycle(cycle) else { return false }
            snapshot.timeline = timeline
            snapshot.timelineUpdated = Date()
        } else if snapshot.settings.showChart {
            complete = false
        }

        guard isCurrentCycle(cycle) else { return false }
        if (popoverOpen || snapshot.settings.menuBarMetric == .quota), let quotas = try? await client.quotas() {
            guard isCurrent(cycle) else { return false }
            snapshot.quotas = quotas
            snapshot.quotasLoaded = true
        } else if popoverOpen || snapshot.settings.menuBarMetric == .quota {
            complete = false
        }

        return complete
    }

    private func apply(_ error: ProxyError) {
        snapshot.consecutiveFailures += 1
        switch error {
        case .unreachable:
            snapshot.state = .unreachable
        case .unauthorized:
            snapshot.state = .unauthorized
        case .http, .decoding, .transport, .inconclusive:
            // A timeout is degraded, not stopped: something may well still be running.
            snapshot.state = .degraded(error.userMessage)
        }
    }

    private func publish() {
        let value = snapshot
        for handler in observers.values { handler(value) }
    }
}
