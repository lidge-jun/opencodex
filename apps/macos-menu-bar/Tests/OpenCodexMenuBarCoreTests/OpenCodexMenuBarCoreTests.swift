import Foundation
import XCTest
@testable import OpenCodexMenuBarCore

final class OpenCodexMenuBarCoreTests: XCTestCase {
    func testDecodesAdditiveStatusContract() throws {
        let status = try OcxClient.decodeStatus("""
        launcher notice
        {
          "schemaVersion": 1,
          "proxy": {
            "running": true,
            "pid": 812,
            "health": {
              "ok": true,
              "url": "http://127.0.0.1:10100/healthz",
              "message": "ok v2.7.33, uptime 42s",
              "version": "2.7.33",
              "uptimeSeconds": 42.4
            }
          },
          "dashboard": { "url": "http://localhost:10100/" },
          "listen": { "port": 10100, "hostname": null, "source": "runtime" },
          "runtime": { "source": "bundled", "futureField": true },
          "service": { "summary": "installed (launchd; logs: service.log)" },
          "futureTopLevel": true
        }
        trailing notice
        """)

        XCTAssertEqual(status.phase, .running)
        XCTAssertEqual(status.proxy.health.version, "2.7.33")
        XCTAssertEqual(status.proxy.health.uptimeSeconds, 42.4)
        XCTAssertTrue(status.serviceInstalled)
    }

    func testOlderStatusStillDecodes() throws {
        let status = try fixture(serviceSummary: "not installed (logs: service.log)")

        XCTAssertEqual(status.phase, .stopped)
        XCTAssertNil(status.proxy.health.version)
        XCTAssertNil(status.proxy.health.uptimeSeconds)
    }

    func testServiceCommandPlan() throws {
        let status = try fixture(serviceSummary: "installed (launchd; logs: service.log)")

        XCTAssertEqual(commandPlan(for: .start, status: status), [.run(["service", "start"])])
        XCTAssertEqual(commandPlan(for: .restart, status: status), [
            .run(["service", "stop"]),
            .run(["service", "start"]),
        ])
        XCTAssertEqual(commandPlan(for: .stop, status: status), [.run(["stop"])])
    }


    func testStaleServiceCommandPlan() throws {
        let status = try fixture(serviceSummary: "installed, but stale (launchd; logs: service.log)")

        XCTAssertTrue(status.serviceInstalled)
        XCTAssertTrue(status.serviceStale)
        XCTAssertFalse(status.serviceStartable)
        XCTAssertEqual(status.phase, .failed)
        XCTAssertEqual(commandPlan(for: .start, status: status), [.run(["service", "install"])])
        XCTAssertEqual(commandPlan(for: .restart, status: status), [
            .run(["stop"]),
            .run(["service", "install"]),
        ])
        XCTAssertEqual(commandPlan(for: .stop, status: status), [.run(["stop"])])
    }

    func testStandaloneCommandPlan() throws {
        let status = try fixture(serviceSummary: "not installed (logs: service.log)")

        XCTAssertEqual(commandPlan(for: .start, status: status), [.launch(["start"])])
        XCTAssertEqual(commandPlan(for: .restart, status: status), [
            .run(["stop"]),
            .launch(["start"]),
        ])
    }

    func testLocatorCandidatePriority() {
        let paths = OcxLocator.candidatePaths(
            environment: [
                "OCX_CLI_PATH": "/custom/ocx",
                "PATH": "/custom:/opt/homebrew/bin",
            ],
            homeDirectory: URL(fileURLWithPath: "/Users/example")
        )

        XCTAssertEqual(paths.first, "/custom/ocx")
        XCTAssertEqual(paths.filter { $0 == "/opt/homebrew/bin/ocx" }.count, 1)
    }

    private func fixture(serviceSummary: String) throws -> OcxStatus {
        try OcxClient.decodeStatus("""
        {
          "schemaVersion": 1,
          "proxy": {
            "running": false,
            "pid": null,
            "health": { "ok": false, "url": "http://127.0.0.1:10100/healthz", "message": "unreachable" }
          },
          "dashboard": { "url": "http://localhost:10100/" },
          "listen": { "port": 10100, "hostname": null, "source": "config" },
          "runtime": { "source": "bundled" },
          "service": { "summary": "\(serviceSummary)" }
        }
        """)
    }
}
