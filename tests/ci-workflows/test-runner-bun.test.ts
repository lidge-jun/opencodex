import { describe, expect, test } from "bun:test";
import { resolveTestRunnerBun, type TestRunnerBunDeps } from "../../scripts/lib/test-runner-bun";

function fixture(overrides: Partial<TestRunnerBunDeps> = {}): TestRunnerBunDeps {
  return {
    pin: "1.4.0",
    currentVersion: "1.4.2",
    execPath: "/project/node_modules/bun/bin/bun.exe",
    env: {},
    pathEntries: [],
    homeDir: "/home/contributor",
    platform: "linux",
    probeVersion: () => undefined,
    ...overrides,
  };
}

describe("pinned test runner Bun", () => {
  test("reuses the running executable when its version matches, before checking overrides", () => {
    const deps = fixture({
      currentVersion: "1.4.0",
      env: { OCX_TEST_RUNNER_BUN: "/wrong/bun" },
      probeVersion: () => { throw new Error("must not probe"); },
    });
    expect(resolveTestRunnerBun(deps)).toBe("/project/node_modules/bun/bin/bun.exe");
  });

  test("accepts a matching explicit override before a matching PATH binary", () => {
    const probed: string[] = [];
    const binary = resolveTestRunnerBun(fixture({
      env: { OCX_TEST_RUNNER_BUN: "/opt/pinned/bun" },
      pathEntries: ["/another"],
      probeVersion: path => { probed.push(path); return "1.4.0\n"; },
    }));
    expect(binary).toBe("/opt/pinned/bun");
    expect(probed).toEqual(["/opt/pinned/bun"]);
  });

  test.each(["1.4.2", undefined, ""])("rejects an override reporting %s without PATH fallback", version => {
    const probed: string[] = [];
    const deps = fixture({
      env: { OCX_TEST_RUNNER_BUN: "/override/bun" },
      pathEntries: ["/good"],
      probeVersion: path => { probed.push(path); return path === "/good/bun" ? "1.4.0" : version; },
    });
    expect(() => resolveTestRunnerBun(deps)).toThrow("OCX_TEST_RUNNER_BUN reports");
    expect(probed).toEqual(["/override/bun"]);
  });

  test("skips every node_modules PATH directory even if its binary matches", () => {
    const probed: string[] = [];
    const binary = resolveTestRunnerBun(fixture({
      pathEntries: ["/project/node_modules/.bin", "/project/node_modules/bun/bin", "/external"],
      probeVersion: path => { probed.push(path); return "1.4.0"; },
    }));
    expect(binary).toBe("/external/bun");
    expect(probed).toEqual(["/external/bun"]);
  });

  test("continues past missing, failing and wrong-version probes; first matching PATH entry wins", () => {
    const probed: string[] = [];
    const binary = resolveTestRunnerBun(fixture({
      pathEntries: ["", "/missing", "/broken", "/runtime", "/first", "/later"],
      probeVersion: path => {
        probed.push(path);
        if (path === "/missing/bun") return undefined;
        if (path === "/broken/bun") throw new Error("not executable");
        return path === "/runtime/bun" ? "1.4.2" : "1.4.0";
      },
    }));
    expect(binary).toBe("/first/bun");
    expect(probed).toEqual(["/missing/bun", "/broken/bun", "/runtime/bun", "/first/bun"]);
  });

  test("falls back to the real home's ~/.bun/bin outside PATH", () => {
    const binary = resolveTestRunnerBun(fixture({
      pathEntries: ["/runtime"],
      probeVersion: path => path === "/home/contributor/.bun/bin/bun" ? "1.4.0" : "1.4.2",
    }));
    expect(binary).toBe("/home/contributor/.bun/bin/bun");
  });

  test("uses bun.exe and case-insensitive node_modules filtering for Windows PATH", () => {
    const probed: string[] = [];
    const binary = resolveTestRunnerBun(fixture({
      platform: "win32",
      homeDir: "C:\\Users\\contributor",
      pathEntries: ["C:\\project\\NODE_MODULES\\.bin", '"C:\\Bun tools"'],
      probeVersion: path => { probed.push(path); return "1.4.0"; },
    }));
    expect(binary).toBe("C:\\Bun tools\\bun.exe");
    expect(probed).toEqual(["C:\\Bun tools\\bun.exe"]);
  });

  test("reports both versions, crash references and manual setup when no binary matches", () => {
    let message = "";
    try { resolveTestRunnerBun(fixture()); } catch (error) { message = (error as Error).message; }
    for (const expected of ["1.4.2", "1.4.0", "OCX_TEST_RUNNER_BUN", "6713", "4821", "bun-v1.4.0", "No download"]) {
      expect(message).toContain(expected);
    }
  });

  test("rejects an empty override rather than silently selecting PATH", () => {
    expect(() => resolveTestRunnerBun(fixture({
      env: { OCX_TEST_RUNNER_BUN: "" },
      pathEntries: ["/good"],
      probeVersion: () => "1.4.0",
    }))).toThrow("OCX_TEST_RUNNER_BUN reports no usable version");
  });

  test("rejects an unpinned version before executing probes", () => {
    expect(() => resolveTestRunnerBun(fixture({ pin: "^1.4.0" }))).toThrow("exact Bun version");
  });
});
