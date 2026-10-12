import Foundation

public enum ProxyError: Error, Equatable {
    /// The connection was refused — nothing is listening. This is the only transport
    /// result that proves the proxy is gone; timeouts get `.inconclusive`.
    case unreachable
    /// 401 — a non-loopback bind that requires a credential.
    case unauthorized
    case http(Int)
    case decoding
    /// A transport failure that is not evidence the proxy is down (TLS, policy, and
    /// other non-connectivity URLSession errors).
    case transport
    /// The request never completed — a timeout or a socket dropped mid-response. This
    /// proves nothing either way, and must not be read as "the proxy is gone".
    case inconclusive

    /// Human sentences only. Response bodies can echo configuration values, so they
    /// never reach the UI or a log.
    public var userMessage: String {
        switch self {
        case .unreachable: return "The proxy is not running."
        case .unauthorized: return "This proxy requires an API key."
        case .http(let code): return "The proxy returned an unexpected status (\(code))."
        case .decoding: return "The proxy returned a response this app could not read."
        case .transport: return "The connection to the proxy failed."
        case .inconclusive: return "The proxy did not respond in time."
        }
    }
}

/// Supplies the optional management API key. Injected so tests never touch the real
/// Keychain and so the app can swap the source without touching transport code.
public protocol CredentialStore: Sendable {
    func loadAPIKey() -> String?
}

public struct KeychainCredentialStore: CredentialStore {
    public init() {}
    public func loadAPIKey() -> String? { Keychain.read() }
}

/// HTTP client for the OpenCodex management API.
///
/// An actor because the endpoint and key are mutated from both the polling loop and user
/// actions; the isolation makes that data-race-free by construction rather than by
/// convention.
public actor ProxyClient {
    private let session: URLSession
    private let credentials: CredentialStore
    private var endpoint: ProxyEndpoint
    private var apiKey: String?
    /// Ensures the lazy credential load happens at most once per client.
    private var didAttemptCredentialLoad = false

    public init(
        endpoint: ProxyEndpoint,
        session: URLSession? = nil,
        credentials: CredentialStore = KeychainCredentialStore()
    ) {
        self.endpoint = endpoint
        self.credentials = credentials
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.ephemeral
            config.timeoutIntervalForRequest = 4
            config.waitsForConnectivity = false
            self.session = URLSession(configuration: config)
        }
    }

    public var currentEndpoint: ProxyEndpoint { endpoint }

    public func updateEndpoint(_ endpoint: ProxyEndpoint) { self.endpoint = endpoint }

    public func setAPIKey(_ key: String?) {
        self.apiKey = key
        // An explicitly supplied key replaces the lazy path entirely.
        self.didAttemptCredentialLoad = true
    }

    // MARK: - Reads

    public func health() async throws -> StartupHealth { try await get("api/startup-health") }
    public func settings() async throws -> ProxySettings { try await get("api/settings") }
    public func config() async throws -> ProxyConfigSummary { try await get("api/config") }
    public func providers() async throws -> [ProviderSummary] { try await get("api/providers") }

    public func usage(range: UsageRange = .sevenDays) async throws -> UsageReport {
        try await get("api/usage", query: [URLQueryItem(name: "range", value: range.rawValue)])
    }

    public func companionSettings() async throws -> CompanionSettingsResponse {
        try await get("api/companion/settings")
    }

    public func timeline(_ settings: CompanionSettings) async throws -> UsageTimeline {
        var query = [
            URLQueryItem(name: "hours", value: String(settings.chartHours)),
            URLQueryItem(name: "bucketMinutes", value: String(settings.bucketMinutes)),
            URLQueryItem(name: "metric", value: settings.tokenMetric.rawValue),
            URLQueryItem(name: "aggregation", value: settings.aggregation.rawValue),
            URLQueryItem(name: "grouping", value: settings.chartGrouping.rawValue),
        ]
        if let models = settings.models, !models.isEmpty {
            query.append(URLQueryItem(name: "models", value: models.joined(separator: ",")))
        }
        query.append(contentsOf: settings.hiddenProviders.map { URLQueryItem(name: "hiddenProvider", value: $0) })
        let timeline: UsageTimeline = try await get("api/usage/timeline", query: query)
        return timeline.projected(settings)
    }

    public func quotas() async throws -> [QuotaReport] {
        let envelope: QuotaEnvelope = try await get("api/provider-quotas")
        return envelope.reports ?? []
    }

    /// What a liveness probe actually established.
    ///
    /// Three states, not two. "Did not get a usable answer" and "nothing is listening"
    /// are different facts, and conflating them let a stop be reported as confirmed
    /// while an HTTP server was still running behind a 500 or a decode failure.
    public enum Liveness: Equatable, Sendable {
        /// Something answered — any HTTP status, including 401/403/500, or a body we
        /// could not decode. The port is occupied.
        case reachable
        /// The connection was refused. This is the only proof that the proxy is gone.
        case refused
        /// A timeout or other transport failure: no conclusion either way.
        case indeterminate
    }

    /// A short probe: the default 4s read timeout would let a single liveness check
    /// overrun the stop deadline it is supposed to respect.
    public func liveness(timeout: TimeInterval = 1.5) async -> Liveness {
        do {
            // Deliberately bypasses `send()`: its 401 credential retry would spend a
            // second full timeout re-asking a question the 401 already answered, and a
            // failed retry would downgrade a known-reachable result to indeterminate.
            _ = try await perform(
                method: "GET", path: "api/settings", query: [],
                body: nil as EmptyBody?, timeout: timeout
            )
            return .reachable
        } catch ProxyError.unauthorized, ProxyError.decoding {
            // Both prove a server answered.
            return .reachable
        } catch ProxyError.http {
            return .reachable
        } catch ProxyError.unreachable {
            // Connection refused: nothing is listening on the port.
            return .refused
        } catch {
            // Timeouts, dropped sockets, and anything else: no conclusion.
            return .indeterminate
        }
    }

    /// Convenience for callers that only need "is anything there".
    public func isReachable() async -> Bool {
        await liveness() != .refused
    }

    // MARK: - Writes

    /// `POST /api/stop`. Returns once the proxy has accepted the request.
    ///
    /// The proxy answers 200 *before* draining, and it stops the launchd service first so
    /// nothing respawns it. Callers must poll `liveness()` rather than treat this return
    /// as "stopped".
    ///
    /// The response carries `success: false` when `restoreNativeCodex()` failed
    /// (`src/server/management-api.ts:145-147`): the proxy still shuts down, but native
    /// Codex was left pointing at a port that is about to close. Only the boolean is
    /// decoded — the accompanying message is a server-formatted string and never reaches
    /// the UI.
    @discardableResult
    public func stop() async throws -> Bool {
        let data = try await send(method: "POST", path: "api/stop", body: nil as EmptyBody?)
        guard let result = try? JSONDecoder().decode(StopResult.self, from: data) else {
            // An undecodable body is not a reason to claim the restore failed.
            return true
        }
        return result.success ?? true
    }

    /// `PATCH /api/providers?name=<name>` with a body of exactly `{"disabled": <bool>}`.
    ///
    /// A disabled-only patch skips the proxy's heavier merged-shape validators, so adding
    /// any second field would silently change the request class.
    public func setProviderDisabled(_ name: String, disabled: Bool) async throws {
        _ = try await send(
            method: "PATCH",
            path: "api/providers",
            query: [URLQueryItem(name: "name", value: name)],
            body: ProviderDisabledPatch(disabled: disabled)
        )
    }

    // MARK: - Transport

    private func get<T: Decodable>(
        _ path: String,
        query: [URLQueryItem] = [],
        timeout: TimeInterval? = nil
    ) async throws -> T {
        let data = try await send(
            method: "GET", path: path, query: query,
            body: nil as EmptyBody?, timeout: timeout
        )
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw ProxyError.decoding
        }
    }

    private func send<Body: Encodable>(
        method: String,
        path: String,
        query: [URLQueryItem] = [],
        body: Body?,
        timeout: TimeInterval? = nil
    ) async throws -> Data {
        let keyAtStart = apiKey
        do {
            return try await perform(method: method, path: path, query: query, body: body, timeout: timeout)
        } catch ProxyError.unauthorized {
            // A loopback proxy needs no credential, so a 401 means this install is bound
            // to a non-loopback host.
            //
            // Reentrancy matters here: the actor suspends across the request, so several
            // calls can be in flight and all receive 401. Retry eligibility is therefore
            // decided per request, against the key THAT request actually sent — not
            // against a single global "already tried" flag. A concurrent caller that
            // started before the key was loaded must still get to retry with it.
            guard let key = try await credentialForRetry(after: keyAtStart) else {
                throw ProxyError.unauthorized
            }
            return try await perform(method: method, path: path, query: query, body: body, key: key, timeout: timeout)
        }
    }

    /// The key to retry with, or `nil` when this request already used the current
    /// credential (so retrying would repeat an identical, failing call).
    private func credentialForRetry(after keyAtStart: String?) async throws -> String? {
        // Another in-flight call already loaded a key this request did not use.
        if let current = apiKey, current != keyAtStart { return current }
        // This request already carried the newest key: a stale credential, not a
        // missing one. Never loop.
        if apiKey != nil, apiKey == keyAtStart { return nil }

        guard !didAttemptCredentialLoad else { return nil }
        didAttemptCredentialLoad = true
        guard let stored = credentials.loadAPIKey(), !stored.isEmpty else { return nil }
        apiKey = stored
        return stored
    }

    private func perform<Body: Encodable>(
        method: String,
        path: String,
        query: [URLQueryItem],
        body: Body?,
        key: String? = nil,
        timeout: TimeInterval? = nil
    ) async throws -> Data {
        guard var components = URLComponents(
            url: endpoint.baseURL.appendingPathComponent(path),
            resolvingAgainstBaseURL: false
        ) else { throw ProxyError.decoding }
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw ProxyError.decoding }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout ?? (method == "GET" ? 4 : 6)
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
        request.setValue("OpenCodexWidget/\(version)", forHTTPHeaderField: "User-Agent")
        if let credential = key ?? apiKey {
            request.setValue(credential, forHTTPHeaderField: "x-opencodex-api-key")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try? JSONEncoder().encode(body)
        }

        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw ProxyError.decoding }
            if http.statusCode == 401 { throw ProxyError.unauthorized }
            guard (200..<300).contains(http.statusCode) else {
                throw ProxyError.http(http.statusCode)
            }
            return data
        } catch let error as ProxyError {
            throw error
        } catch let error as URLError {
            switch error.code {
            case .cancelled:
                // Propagate cancellation rather than reporting a stopped proxy: the
                // polling coordinator cancels in-flight work whenever the popover closes.
                throw CancellationError()
            case .cannotConnectToHost:
                // The one code that actually proves nothing is listening.
                throw ProxyError.unreachable
            case .timedOut, .networkConnectionLost, .cannotFindHost,
                 .notConnectedToInternet, .dnsLookupFailed:
                // A timeout or a dropped socket says the request failed, not that the
                // server is gone. Collapsing these into `.unreachable` is what let a
                // stop be reported as confirmed while the proxy was still running.
                throw ProxyError.inconclusive
            default:
                throw ProxyError.transport
            }
        }
    }
}

private struct QuotaEnvelope: Decodable {
    let generatedAt: Double?
    let reports: [QuotaReport]?
}

private struct ProviderDisabledPatch: Encodable {
    let disabled: Bool
}

private struct StopResult: Decodable {
    let success: Bool?
}

private struct EmptyBody: Encodable {}
