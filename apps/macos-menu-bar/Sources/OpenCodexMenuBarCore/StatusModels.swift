import Foundation

public struct OcxStatus: Decodable, Equatable {
    public struct Proxy: Decodable, Equatable {
        public struct Health: Decodable, Equatable {
            public let ok: Bool
            public let url: String
            public let message: String
            public let version: String?
            public let uptimeSeconds: Double?
        }

        public let running: Bool
        public let pid: Int?
        public let health: Health
    }

    public struct Dashboard: Decodable, Equatable {
        public let url: String
    }

    public struct Listen: Decodable, Equatable {
        public let port: Int
        public let hostname: String?
        public let source: String
    }

    public struct Runtime: Decodable, Equatable {
        public let source: String
    }

    public struct Service: Decodable, Equatable {
        public let summary: String
    }

    public let schemaVersion: Int
    public let proxy: Proxy
    public let dashboard: Dashboard
    public let listen: Listen
    public let runtime: Runtime
    public let service: Service

    public var serviceInstalled: Bool {
        service.summary.hasPrefix("installed")
    }

    public var phase: ProxyPhase {
        if proxy.running { return .running }
        if proxy.pid != nil || proxy.health.ok { return .degraded }
        return .stopped
    }
}

public enum ProxyPhase: Equatable {
    case checking
    case running
    case stopped
    case degraded
    case cliMissing
    case failed
}

public enum ProxyControlOperation: Equatable {
    case start
    case restart
    case stop
}

public enum OcxCommandStep: Equatable {
    case run([String])
    case launch([String])
}

/// Keep lifecycle policy in the existing CLI. The companion app only chooses the
/// service-aware sequence and never sends signals or edits opencodex state itself.
public func commandPlan(for operation: ProxyControlOperation, status: OcxStatus) -> [OcxCommandStep] {
    switch operation {
    case .start:
        return status.serviceInstalled
            ? [.run(["service", "start"])]
            : [.launch(["start"])]
    case .restart:
        return status.serviceInstalled
            ? [.run(["service", "stop"]), .run(["service", "start"])]
            : [.run(["stop"]), .launch(["start"])]
    case .stop:
        return [.run(["stop"])]
    }
}
