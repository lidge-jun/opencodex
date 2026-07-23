import Foundation

public final class OcxLocator {
    public static let defaultsKey = "OcxExecutablePath"

    private let defaults: UserDefaults
    private let fileManager: FileManager

    public init(defaults: UserDefaults = .standard, fileManager: FileManager = .default) {
        self.defaults = defaults
        self.fileManager = fileManager
    }

    public var hasCustomPath: Bool {
        defaults.string(forKey: Self.defaultsKey) != nil
    }

    public func saveCustomPath(_ url: URL) {
        defaults.set(url.standardizedFileURL.path, forKey: Self.defaultsKey)
    }

    public func clearCustomPath() {
        defaults.removeObject(forKey: Self.defaultsKey)
    }

    public func locate() -> URL? {
        if let customPath = defaults.string(forKey: Self.defaultsKey),
           let custom = executableURL(at: customPath) {
            return custom
        }

        let environment = ProcessInfo.processInfo.environment
        let home = fileManager.homeDirectoryForCurrentUser
        for path in Self.candidatePaths(environment: environment, homeDirectory: home, fileManager: fileManager) {
            if let candidate = executableURL(at: path) {
                return candidate
            }
        }
        return nil
    }

    public static func candidatePaths(
        environment: [String: String],
        homeDirectory: URL,
        fileManager: FileManager = .default
    ) -> [String] {
        var paths: [String] = []
        if let explicit = environment["OCX_CLI_PATH"], !explicit.isEmpty {
            paths.append(explicit)
        }
        if let path = environment["PATH"] {
            paths.append(contentsOf: path.split(separator: ":").map { String($0) + "/ocx" })
        }

        let home = homeDirectory.path
        paths.append(contentsOf: [
            "/opt/homebrew/bin/ocx",
            "/usr/local/bin/ocx",
            "\(home)/.bun/bin/ocx",
            "\(home)/.volta/bin/ocx",
            "\(home)/.local/bin/ocx",
            "\(home)/Library/pnpm/ocx",
        ])

        paths.append(contentsOf: versionManagerCandidates(
            root: homeDirectory.appendingPathComponent(".nvm/versions/node", isDirectory: true),
            suffix: "bin/ocx",
            fileManager: fileManager
        ))
        paths.append(contentsOf: versionManagerCandidates(
            root: homeDirectory.appendingPathComponent(".local/share/fnm/node-versions", isDirectory: true),
            suffix: "installation/bin/ocx",
            fileManager: fileManager
        ))

        var seen = Set<String>()
        return paths.filter { seen.insert(($0 as NSString).standardizingPath).inserted }
    }

    private static func versionManagerCandidates(
        root: URL,
        suffix: String,
        fileManager: FileManager
    ) -> [String] {
        let versions = (try? fileManager.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )) ?? []
        return versions
            .sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedDescending }
            .map { $0.appendingPathComponent(suffix).path }
    }

    private func executableURL(at path: String) -> URL? {
        let standardized = (path as NSString).expandingTildeInPath
        guard fileManager.isExecutableFile(atPath: standardized) else { return nil }
        return URL(fileURLWithPath: standardized).standardizedFileURL
    }
}
