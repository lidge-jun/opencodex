import Foundation
import MenuBarCore

enum DiscoverySuite {
    static func run(_ t: TestRunner) {
        let root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("ocx-discovery-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        func writeRecord(_ contents: String) throws {
            try contents.write(
                to: root.appendingPathComponent("runtime-port.json"),
                atomically: true,
                encoding: .utf8
            )
        }

        t.test("discovery: honours a valid record") {
            try writeRecord(#"{"pid": 14582, "port": 10100}"#)
            t.equal(ProxyDiscovery.resolve(configDirectory: root).port, 10100)
        }

        t.test("discovery: honours a non-default port") {
            try writeRecord(#"{"pid": 1, "port": 18080}"#)
            t.equal(ProxyDiscovery.resolve(configDirectory: root).port, 18080)
        }

        t.test("discovery: a record without pid still resolves") {
            try writeRecord(#"{"port": 10250}"#)
            t.equal(ProxyDiscovery.resolve(configDirectory: root).port, 10250)
        }

        t.test("discovery: malformed JSON falls back to the default port") {
            try writeRecord("{not json at all")
            t.equal(ProxyDiscovery.resolve(configDirectory: root).port, ProxyDiscovery.defaultPort)
        }

        t.test("discovery: out-of-range ports fall back to the default") {
            for invalid in ["0", "70000", "-1"] {
                try writeRecord(#"{"port": \#(invalid)}"#)
                t.equal(
                    ProxyDiscovery.resolve(configDirectory: root).port,
                    ProxyDiscovery.defaultPort,
                    "port \(invalid)"
                )
            }
        }

        t.test("discovery: a missing file falls back to the default port") {
            let empty = root.appendingPathComponent("empty-\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: empty, withIntermediateDirectories: true)
            t.equal(ProxyDiscovery.resolve(configDirectory: empty).port, ProxyDiscovery.defaultPort)
        }

        // The record may carry a hostname, but the app must never follow it: the port
        // file is a convenience, not a redirection mechanism.
        t.test("discovery: host stays loopback even when the record names another host") {
            try writeRecord(#"{"pid": 1, "port": 10100, "hostname": "10.0.0.5"}"#)
            let endpoint = ProxyDiscovery.resolve(configDirectory: root)
            t.equal(endpoint.host, "127.0.0.1")
            t.equal(endpoint.baseURL.absoluteString, "http://127.0.0.1:10100")
        }

        t.test("discovery: OPENCODEX_HOME overrides the default directory") {
            let resolved = ProxyDiscovery.configDirectory(
                environment: ["OPENCODEX_HOME": root.path],
                home: URL(fileURLWithPath: "/nonexistent")
            )
            t.equal(resolved.path, root.path)
        }

        t.test("discovery: a blank OPENCODEX_HOME falls back to the home directory") {
            let home = URL(fileURLWithPath: "/Users/example")
            let resolved = ProxyDiscovery.configDirectory(
                environment: ["OPENCODEX_HOME": "   "],
                home: home
            )
            t.equal(resolved.path, home.appendingPathComponent(".opencodex").path)
        }
    }
}
