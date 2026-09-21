import Foundation

/// A dependency-free assertion harness.
///
/// Why not XCTest or swift-testing: neither ships a usable runtime in Xcode Command Line
/// Tools. `import XCTest` fails module resolution outright, and swift-testing compiles
/// but cannot `dlopen` `Testing.framework` at run time. Requiring a full Xcode install to
/// run the unit tests of a menu bar companion would put the tests out of reach for most
/// contributors and for any CI runner without Xcode selected.
///
/// This harness is ~60 lines, runs as a plain executable, and prints TAP-ish output that
/// both a human and CI can read. If the package ever gains a full-Xcode requirement for
/// other reasons, migrating these cases to swift-testing is mechanical.
public struct TestFailure {
    let test: String
    let message: String
    let file: String
    let line: Int
}

public final class TestRunner {
    private(set) var passed = 0
    private(set) var failures: [TestFailure] = []
    private var current = "<none>"

    public init() {}

    public func test(_ name: String, _ body: () throws -> Void) {
        current = name
        let failuresBefore = failures.count
        do {
            try body()
        } catch {
            failures.append(TestFailure(test: name, message: "threw \(error)", file: #file, line: #line))
            print("FAIL — \(name): threw \(error)")
            return
        }
        // A case that recorded an expectation failure is not a pass, even though its
        // body returned normally.
        if failures.count == failuresBefore {
            passed += 1
            print("ok — \(name)")
        }
    }

    public func expect(
        _ condition: Bool,
        _ message: @autoclosure () -> String,
        file: String = #file,
        line: Int = #line
    ) {
        guard !condition else { return }
        let failure = TestFailure(test: current, message: message(), file: file, line: line)
        failures.append(failure)
        print("FAIL — \(current): \(failure.message) (\(URL(fileURLWithPath: file).lastPathComponent):\(line))")
    }

    public func equal<T: Equatable>(
        _ actual: T,
        _ expected: T,
        _ label: String = "",
        file: String = #file,
        line: Int = #line
    ) {
        expect(
            actual == expected,
            "\(label.isEmpty ? "" : label + ": ")expected \(expected), got \(actual)",
            file: file,
            line: line
        )
    }

    public func notNil<T>(
        _ value: T?,
        _ label: String,
        file: String = #file,
        line: Int = #line
    ) -> T? {
        expect(value != nil, "\(label) should not be nil", file: file, line: line)
        return value
    }

    public func isNil<T>(
        _ value: T?,
        _ label: String,
        file: String = #file,
        line: Int = #line
    ) {
        expect(value == nil, "\(label) should be nil, got \(String(describing: value))", file: file, line: line)
    }

    /// Prints the summary and returns the process exit code.
    public func summarize() -> Int32 {
        print("")
        if failures.isEmpty {
            print("\(passed) passed, 0 failed")
            return 0
        }
        print("\(passed) passed, \(failures.count) FAILED")
        for failure in failures {
            print("  - \(failure.test): \(failure.message)")
        }
        return 1
    }
}
