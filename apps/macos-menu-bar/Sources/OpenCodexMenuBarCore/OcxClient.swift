import Foundation

public enum OcxClientError: LocalizedError {
    case executableNotFound
    case commandFailed(String)
    case invalidStatus

    public var errorDescription: String? {
        switch self {
        case .executableNotFound:
            return "The ocx CLI could not be found."
        case .commandFailed(let message):
            return message
        case .invalidStatus:
            return "ocx returned an invalid status response."
        }
    }
}

public final class OcxClient {
    private let locator: OcxLocator
    private let queue = DispatchQueue(label: "com.opencodex.menubar.cli", qos: .utility)

    public init(locator: OcxLocator) {
        self.locator = locator
    }

    public var executableURL: URL? {
        locator.locate()
    }

    public func fetchStatus(completion: @escaping (Result<OcxStatus, Error>) -> Void) {
        queue.async {
            let result = Result<OcxStatus, Error> {
                let url = try self.requireExecutable()
                let output = try self.run(url, arguments: ["status", "--json"])
                return try Self.decodeStatus(output)
            }
            DispatchQueue.main.async { completion(result) }
        }
    }

    public func perform(
        _ operation: ProxyControlOperation,
        status: OcxStatus,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        queue.async {
            let result = Result<Void, Error> {
                let url = try self.requireExecutable()
                for step in commandPlan(for: operation, status: status) {
                    switch step {
                    case .run(let arguments):
                        _ = try self.run(url, arguments: arguments)
                    case .launch(let arguments):
                        try self.launch(url, arguments: arguments)
                    }
                }
            }
            DispatchQueue.main.async { completion(result) }
        }
    }

    public static func decodeStatus(_ output: String) throws -> OcxStatus {
        guard let start = output.firstIndex(of: "{"), let end = output.lastIndex(of: "}") else {
            throw OcxClientError.invalidStatus
        }
        let json = String(output[start...end])
        guard let data = json.data(using: .utf8) else {
            throw OcxClientError.invalidStatus
        }
        do {
            return try JSONDecoder().decode(OcxStatus.self, from: data)
        } catch {
            throw OcxClientError.invalidStatus
        }
    }

    private func requireExecutable() throws -> URL {
        guard let url = locator.locate() else { throw OcxClientError.executableNotFound }
        return url
    }

    private func run(_ executable: URL, arguments: [String]) throws -> String {
        let process = configuredProcess(executable, arguments: arguments)
        let output = Pipe()
        let errors = Pipe()
        process.standardOutput = output
        process.standardError = errors
        process.standardInput = FileHandle.nullDevice

        try process.run()
        process.waitUntilExit()
        let stdout = output.fileHandleForReading.readDataToEndOfFile()
        let stderr = errors.fileHandleForReading.readDataToEndOfFile()
        guard process.terminationStatus == 0 else {
            let raw = String(decoding: stderr.isEmpty ? stdout : stderr, as: UTF8.self)
            let message = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            let fallback = "ocx exited with status \(process.terminationStatus)."
            throw OcxClientError.commandFailed(message.isEmpty ? fallback : String(message.prefix(600)))
        }
        return String(decoding: stdout, as: UTF8.self)
    }

    private func launch(_ executable: URL, arguments: [String]) throws {
        let process = configuredProcess(executable, arguments: arguments)
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        try process.run()
    }

    private func configuredProcess(_ executable: URL, arguments: [String]) -> Process {
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments

        var environment = ProcessInfo.processInfo.environment
        environment.merge(Self.serviceEnvironment()) { current, _ in current }
        let executableDirectory = executable.deletingLastPathComponent().path
        let inheritedPath = environment["PATH"] ?? ""
        let standardPaths = [
            executableDirectory,
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ]
        environment["PATH"] = Self.uniquePath((standardPaths + inheritedPath.split(separator: ":").map(String.init)))
        process.environment = environment
        return process
    }

    private static func serviceEnvironment() -> [String: String] {
        let plist = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents/com.opencodex.proxy.plist")
        guard let data = try? Data(contentsOf: plist),
              let object = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil),
              let dictionary = object as? [String: Any],
              let values = dictionary["EnvironmentVariables"] as? [String: Any] else {
            return [:]
        }
        var safe: [String: String] = [:]
        for key in ["CODEX_HOME", "OPENCODEX_HOME"] {
            if let value = values[key] as? String, !value.isEmpty {
                safe[key] = value
            }
        }
        return safe
    }

    private static func uniquePath(_ entries: [String]) -> String {
        var seen = Set<String>()
        return entries.filter { !$0.isEmpty && seen.insert($0).inserted }.joined(separator: ":")
    }
}
