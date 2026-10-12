import Foundation
import MenuBarCore

/// Exercises the polling contract against a stubbed transport instead of asserting that
/// four constants still hold the values they were declared with.
enum PollingSuite {
    private static func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return URLSession(configuration: config)
    }

    private static func sync<T>(_ operation: @escaping () async -> T) -> T {
        let semaphore = DispatchSemaphore(value: 0)
        let box = Box<T>()
        Task {
            box.value = await operation()
            semaphore.signal()
        }
        semaphore.wait()
        return box.value!
    }

    private final class Box<T>: @unchecked Sendable { var value: T? }

    /// Polls the coordinator's own waiter count, so registration is observed rather
    /// than assumed from elapsed time.
    private static func waitForWaiter(_ coordinator: PollingCoordinator, timeout: TimeInterval = 5) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await coordinator.waiterCount > 0 { return true }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        return false
    }

    private final class Flag: @unchecked Sendable {
        private let lock = NSLock()
        private var flag = false
        var value: Bool { lock.lock(); defer { lock.unlock() }; return flag }
        func set() { lock.lock(); flag = true; lock.unlock() }
    }

    private static let healthOK = #"{"status":"protected","serviceInstalled":true,"serviceEnabled":true}"#
    private static let usageOK = #"{"range":"7d","summary":{"requests":10},"days":[{"date":"d","requests":10}]}"#
    private static let quotasOK = #"{"reports":[{"provider":"p","quota":{"weeklyPercent":5}}]}"#
    private static let providersOK = #"[{"name":"openai"}]"#
    private static let configOK = #"{"defaultProvider":"openai"}"#

    private static func paths() -> [String] {
        StubProtocol.recorded.compactMap { $0.url?.path }
    }

    static func run(_ t: TestRunner) {
        let endpoint = ProxyEndpoint.default

        func makeCoordinator() -> PollingCoordinator {
            let client = ProxyClient(endpoint: endpoint, session: makeSession(),
                                     credentials: NoCredentials())
            return PollingCoordinator(client: client, endpoint: endpoint)
        }

        // The whole point of gating: a closed popover must not trigger aggregation.
        t.test("polling: a closed popover fetches only liveness") {
            StubProtocol.reset([.init(status: 200, body: healthOK, urlError: nil)])
            let coordinator = makeCoordinator()
            sync { await coordinator.refresh() }
            t.equal(paths(), ["/api/startup-health", "/api/companion/settings", "/api/usage", "/api/usage/timeline"])
        }

        t.test("polling: opening the popover fetches on-open and aggregation reads") {
            StubProtocol.reset([
                .init(status: 200, body: healthOK, urlError: nil),
                .init(status: 200, body: providersOK, urlError: nil),
                .init(status: 200, body: configOK, urlError: nil),
                .init(status: 200, body: usageOK, urlError: nil),
                .init(status: 200, body: quotasOK, urlError: nil),
            ])
            let coordinator = makeCoordinator()
            let snapshot = sync { () -> ProxySnapshot in
                await coordinator.setPopoverOpen(true)
                return await coordinator.current
            }
            t.expect(paths().contains("/api/providers"), "providers fetched on open")
            t.expect(paths().contains("/api/usage"), "usage fetched on open")
            t.expect(paths().contains("/api/provider-quotas"), "quotas fetched on open")
            t.equal(snapshot.providersLoaded, true)
            t.equal(snapshot.quotasLoaded, true)
            t.equal(snapshot.defaultProvider, "openai")
        }

        // Reopening within the aggregation window should refresh cheap reads only.
        t.test("polling: a second open reuses aggregation but refreshes on-open reads") {
            StubProtocol.reset([
                .init(status: 200, body: healthOK, urlError: nil),
                .init(status: 200, body: providersOK, urlError: nil),
                .init(status: 200, body: configOK, urlError: nil),
                .init(status: 200, body: usageOK, urlError: nil),
                .init(status: 200, body: quotasOK, urlError: nil),
                .init(status: 200, body: healthOK, urlError: nil),
                .init(status: 200, body: providersOK, urlError: nil),
                .init(status: 200, body: configOK, urlError: nil),
            ])
            let coordinator = makeCoordinator()
            sync {
                await coordinator.setPopoverOpen(true)
                await coordinator.setPopoverOpen(false)
                await coordinator.setPopoverOpen(true)
            }
            let usageCalls = paths().filter { $0 == "/api/usage" }.count
            let providerCalls = paths().filter { $0 == "/api/providers" }.count
            t.equal(usageCalls, 1, "aggregation respects its interval")
            t.equal(providerCalls, 2, "on-open reads run every open")
        }

        t.test("polling: a refused proxy becomes unreachable and counts a failure") {
            StubProtocol.reset([.init(status: 0, body: "", urlError: .cannotConnectToHost)])
            let coordinator = makeCoordinator()
            let snapshot = sync { () -> ProxySnapshot in
                await coordinator.refresh()
                return await coordinator.current
            }
            t.equal(snapshot.state, .unreachable)
            t.equal(snapshot.consecutiveFailures, 1)
            t.equal(snapshot.showsData, false)
        }

        t.test("polling: repeated failures widen the interval to the backoff value") {
            StubProtocol.reset(Array(repeating: .init(status: 0, body: "", urlError: .cannotConnectToHost), count: 4))
            let coordinator = makeCoordinator()
            let interval = sync { () -> TimeInterval in
                for _ in 0..<3 { await coordinator.refresh() }
                return await coordinator.currentInterval
            }
            t.equal(interval, PollingCoordinator.backoffInterval)
        }

        t.test("polling: a recovered proxy resets the failure count and interval") {
            StubProtocol.reset([
                .init(status: 0, body: "", urlError: .cannotConnectToHost),
                .init(status: 200, body: healthOK, urlError: nil),
            ])
            let coordinator = makeCoordinator()
            let snapshot = sync { () -> ProxySnapshot in
                await coordinator.refresh()
                await coordinator.refresh()
                return await coordinator.current
            }
            t.equal(snapshot.consecutiveFailures, 0)
            t.equal(snapshot.state.isRunning, true)
        }

        // A degraded proxy keeps its last-known numbers with an explicit age, rather
        // than blanking the panel.
        t.test("polling: a 500 degrades while retaining previously loaded data") {
            StubProtocol.reset([
                .init(status: 200, body: healthOK, urlError: nil),
                .init(status: 200, body: providersOK, urlError: nil),
                .init(status: 200, body: configOK, urlError: nil),
                .init(status: 200, body: usageOK, urlError: nil),
                .init(status: 200, body: quotasOK, urlError: nil),
                .init(status: 500, body: "", urlError: nil),
            ])
            let coordinator = makeCoordinator()
            let snapshot = sync { () -> ProxySnapshot in
                await coordinator.setPopoverOpen(true)
                await coordinator.refresh()
                return await coordinator.current
            }
            if case .degraded = snapshot.state {
                t.expect(true, "degraded")
            } else {
                t.expect(false, "expected degraded, got \(snapshot.state)")
            }
            t.equal(snapshot.showsData, true, "stale-but-labelled beats blank")
            _ = t.notNil(snapshot.usage, "usage retained")
        }

        t.test("polling: the recommended command is carried into the snapshot") {
            StubProtocol.reset([
                .init(status: 200,
                      body: #"{"status":"at-risk","recommendedCommand":"ocx service install"}"#,
                      urlError: nil),
            ])
            let coordinator = makeCoordinator()
            let snapshot = sync { () -> ProxySnapshot in
                await coordinator.refresh()
                return await coordinator.current
            }
            t.equal(snapshot.recommendedCommand, "ocx service install")
        }

        t.test("polling: observers receive the snapshot on registration and on change") {
            StubProtocol.reset([.init(status: 200, body: healthOK, urlError: nil)])
            let coordinator = makeCoordinator()
            let counter = Counter()
            sync {
                await coordinator.observe { _ in counter.bump() }
                await coordinator.refresh()
            }
            t.expect(counter.count >= 2, "expected at least 2 notifications, got \(counter.count)")
        }

        // On-open reads are cheap but not free: running them on every liveness tick
        // turned two rarely-changing endpoints into 5-second pollers.
        t.test("polling: a background tick while open does not refetch on-open reads") {
            StubProtocol.reset([
                .init(status: 200, body: healthOK, urlError: nil),
                .init(status: 200, body: providersOK, urlError: nil),
                .init(status: 200, body: configOK, urlError: nil),
                .init(status: 200, body: usageOK, urlError: nil),
                .init(status: 200, body: quotasOK, urlError: nil),
                .init(status: 200, body: healthOK, urlError: nil),
            ])
            let coordinator = makeCoordinator()
            sync {
                await coordinator.setPopoverOpen(true)
                await coordinator.refresh()          // ordinary liveness tick
            }
            t.equal(paths().filter { $0 == "/api/providers" }.count, 1, "providers fetched once")
            t.equal(paths().filter { $0 == "/api/config" }.count, 1, "config fetched once")
            t.equal(paths().filter { $0 == "/api/startup-health" }.count, 2, "health fetched twice")
        }

        t.test("polling: a closed popover skips on-open reads entirely") {
            StubProtocol.reset([
                .init(status: 200, body: healthOK, urlError: nil),
                .init(status: 200, body: healthOK, urlError: nil),
            ])
            let coordinator = makeCoordinator()
            sync {
                await coordinator.refresh()
                await coordinator.refresh()
            }
            t.equal(paths().filter { $0 == "/api/providers" }.count, 0)
            t.equal(paths().filter { $0 == "/api/usage" }.count, 1)
        }

        // A failing quota endpoint must not drag its healthy sibling into the 5s tick.
        t.test("polling: a partial aggregation failure still consumes the interval") {
            StubProtocol.reset([
                .init(status: 200, body: healthOK, urlError: nil),
                .init(status: 200, body: providersOK, urlError: nil),
                .init(status: 200, body: configOK, urlError: nil),
                .init(status: 200, body: usageOK, urlError: nil),
                .init(status: 500, body: "", urlError: nil),        // quotas fail
                .init(status: 200, body: healthOK, urlError: nil),  // next tick
            ])
            let coordinator = makeCoordinator()
            sync {
                await coordinator.setPopoverOpen(true)
                await coordinator.refresh()
            }
            t.equal(paths().filter { $0 == "/api/usage" }.count, 1, "usage not refetched after a sibling failure")
        }

        t.test("polling: degraded without any loaded data does not claim to show data") {
            StubProtocol.reset([.init(status: 500, body: "", urlError: nil)])
            let coordinator = makeCoordinator()
            let snapshot = sync { () -> ProxySnapshot in
                await coordinator.refresh()
                return await coordinator.current
            }
            t.equal(snapshot.showsData, false, "no data was ever loaded")
            t.isNil(snapshot.dataAge, "dataAge")
        }

        // refresh() coalesces, so a caller that needs authoritative state afterwards
        // must wait for the cycle that absorbed its request — not just for its own
        // immediate return.
        t.test("polling: refreshAndWait returns only after a cycle has published") {
            // setPopoverOpen already runs a full cycle, so queue enough for both it and
            // the refreshAndWait that follows; the stub falls back to connection-refused
            // once drained, which would look like a stopped proxy.
            StubProtocol.reset([
                .init(status: 200, body: healthOK, urlError: nil),
                .init(status: 200, body: providersOK, urlError: nil),
                .init(status: 200, body: configOK, urlError: nil),
                .init(status: 200, body: usageOK, urlError: nil),
                .init(status: 200, body: quotasOK, urlError: nil),
                .init(status: 200, body: healthOK, urlError: nil),
                .init(status: 200, body: providersOK, urlError: nil),
                .init(status: 200, body: configOK, urlError: nil),
            ])
            let coordinator = makeCoordinator()
            let snapshot = sync { () -> ProxySnapshot in
                await coordinator.setPopoverOpen(true)
                await coordinator.refreshAndWait()
                return await coordinator.current
            }
            // If it returned early the health read would not have landed yet.
            t.equal(snapshot.state.isRunning, true)
            _ = t.notNil(snapshot.lastUpdated, "lastUpdated after refreshAndWait")
        }

        // The first two refreshAndWait tests ran with refreshInFlight == false, so they
        // never entered waitForCompletion() at all. These hold a cycle suspended in the
        // stub so the coalescing path is the one under test.
        t.test("polling: refreshAndWait suspends behind an in-flight cycle and resumes") {
            StubProtocol.reset(Array(
                repeating: .init(status: 200, body: healthOK, urlError: nil), count: 20))
            let gate = DispatchSemaphore(value: 0)
            StubProtocol.setGate(gate)
            defer {
                StubProtocol.setGate(nil)
                for _ in 0..<40 { gate.signal() }
            }

            let coordinator = makeCoordinator()
            let returned = Flag()

            let first = Task { await coordinator.refresh() }
            // Wait for the request to actually reach the gate rather than guessing.
            t.equal(StubProtocol.gateEntered.wait(timeout: .now() + 5), .success,
                    "cycle 1 should reach the gate")

            let waiter = Task {
                await coordinator.refreshAndWait()
                returned.set()
            }
            // Wait for the waiter to actually REGISTER, rather than sleeping and hoping
            // it was scheduled. A fixed sleep let this test pass without ever entering
            // the continuation path.
            t.equal(sync { await waitForWaiter(coordinator) }, true, "waiter should register")
            t.equal(returned.value, false, "refreshAndWait must not return while a cycle is in flight")

            StubProtocol.setGate(nil)
            for _ in 0..<40 { gate.signal() }
            sync { _ = await first.value; _ = await waiter.value }
            t.equal(returned.value, true, "refreshAndWait must resume once the queued cycle publishes")
            t.equal(sync { await coordinator.waiterCount }, 0, "no waiter should remain registered")
        }

        // The queued cycle must FAIL here. Two contract details drive the setup:
        // drainPendingRefresh only runs while the popover is OPEN, and an open cycle
        // consumes health + providers + config + usage + quotas. So the popover is
        // opened first (consuming its own cycle), then one gated 200 lets cycle 1 reach
        // the gate, and every response after that is a refusal. An earlier version
        // queued three 200s with the popover closed and silently re-tested the success
        // path — which is exactly what the new state assertion caught.
        t.test("polling: a waiter is released when the queued cycle fails") {
            StubProtocol.reset([
                .init(status: 200, body: healthOK, urlError: nil),
                .init(status: 200, body: providersOK, urlError: nil),
                .init(status: 200, body: configOK, urlError: nil),
                .init(status: 200, body: usageOK, urlError: nil),
                .init(status: 200, body: quotasOK, urlError: nil),
            ])
            let coordinator = makeCoordinator()
            sync { await coordinator.setPopoverOpen(true) }

            var responses: [StubProtocol.Response] = [.init(status: 200, body: healthOK, urlError: nil)]
            responses.append(contentsOf: Array(
                repeating: .init(status: 0, body: "", urlError: .cannotConnectToHost), count: 30))
            StubProtocol.reset(responses)
            let gate = DispatchSemaphore(value: 0)
            StubProtocol.setGate(gate)
            defer {
                StubProtocol.setGate(nil)
                for _ in 0..<60 { gate.signal() }
            }

            let returned = Flag()
            let first = Task { await coordinator.refresh() }
            t.equal(StubProtocol.gateEntered.wait(timeout: .now() + 5), .success,
                    "cycle 1 should reach the gate")

            let waiter = Task {
                await coordinator.refreshAndWait()
                returned.set()
            }
            t.equal(sync { await waitForWaiter(coordinator) }, true, "waiter should register")
            t.equal(returned.value, false, "must still be suspended")

            StubProtocol.setGate(nil)
            for _ in 0..<60 { gate.signal() }
            let snapshot = sync { () -> ProxySnapshot in
                _ = await first.value
                _ = await waiter.value
                return await coordinator.current
            }
            t.equal(returned.value, true, "a failing queued cycle must still release its waiter")
            // Proves the refusal was actually consumed, not a second 200.
            t.equal(snapshot.state, .unreachable, "the queued cycle must have failed")
        }

        t.test("polling: refreshAndWait survives a failing cycle without hanging") {
            StubProtocol.reset([.init(status: 0, body: "", urlError: .cannotConnectToHost)])
            let coordinator = makeCoordinator()
            let snapshot = sync { () -> ProxySnapshot in
                await coordinator.refreshAndWait()
                return await coordinator.current
            }
            t.equal(snapshot.state, .unreachable)
        }
    }

    private struct NoCredentials: CredentialStore {
        func loadAPIKey() -> String? { nil }
    }

    private final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var value = 0
        var count: Int { lock.lock(); defer { lock.unlock() }; return value }
        func bump() { lock.lock(); value += 1; lock.unlock() }
    }
}
