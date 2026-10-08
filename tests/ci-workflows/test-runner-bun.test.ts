import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTestRunnerBun, type TestRunnerBunDeps } from "../../scripts/lib/test-runner-bun";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";
import { testRunnerBun } from "../../package.json";

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

  test("GUI package uses the pinned wrapper, preserving cwd, filters and failures", () => {
    const guiPackage = JSON.parse(readFileSync(repoPath("gui", "package.json"), "utf8"));
    expect(guiPackage.scripts.test).toBe("bun ../scripts/test-with-pinned-bun.ts tests");
    const root = mkdtempSync(join(tmpdir(), "ocx-gui-test-runner-"));
    const file = join(root, "runner.test.ts");
    const cwd = repoPath("gui");
    writeFileSync(file, `import { expect, test } from "bun:test";
test("selected", () => {
  expect(Bun.version).toBe(${JSON.stringify(testRunnerBun)});
  expect(process.cwd()).toBe(${JSON.stringify(cwd)});
});
test("excluded failure", () => { throw new Error("fixture failure"); });
`);
    try {
      const run = (filter: string) => Bun.spawnSync([
        process.execPath, repoPath("scripts", "test-with-pinned-bun.ts"), "--isolate", file, "-t", filter,
      ], { cwd, stdout: "pipe", stderr: "pipe" });
      const pass = run("^selected$");
      expect(pass.exitCode).toBe(0);
      expect(pass.stderr.toString()).toContain("1 pass");
      const fail = run("^excluded failure$");
      expect(fail.exitCode).not.toBe(0);
      expect(fail.stderr.toString()).toContain("fixture failure");
    } finally {
      removeTreeWithRetry(root);
    }
  });

  // Windows kill("SIGTERM") terminates directly rather than delivering a catchable signal.
  test.skipIf(process.platform === "win32")("wrapper forwards SIGTERM, waits for the child and preserves exit 143", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-test-wrapper-signal-"));
    const file = join(root, "signal.test.ts");
    const pidFile = join(root, "child.pid");
    const signalFile = join(root, "child.signal");
    writeFileSync(file, `import { test } from "bun:test";
import { writeFileSync } from "node:fs";
test("sleep until interrupted", async () => {
  process.on("SIGTERM", () => {
    writeFileSync(${JSON.stringify(signalFile)}, "SIGTERM");
    setTimeout(() => process.exit(0), 75);
  });
  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  await new Promise(() => {});
}, 60_000);
`);
    const wrapper = Bun.spawn([
      process.execPath, repoPath("scripts", "test-with-pinned-bun.ts"), "--isolate", file,
    ], { cwd: root, stdout: "ignore", stderr: "ignore" });
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const readyDeadline = Date.now() + 10_000;
      while (!existsSync(pidFile)) {
        if (Date.now() >= readyDeadline || wrapper.exitCode !== null) throw new Error("wrapper child did not become ready");
        await Bun.sleep(20);
      }
      const childPid = Number(readFileSync(pidFile, "utf8"));
      expect(childPid).toBeGreaterThan(0);
      wrapper.kill("SIGTERM");
      const exitCode = await Promise.race([
        wrapper.exited,
        new Promise<never>((_, reject) => {
          exitTimer = setTimeout(() => reject(new Error("wrapper did not exit after SIGTERM")), 5_000);
        }),
      ]);
      expect(exitCode).toBe(143);
      let childStatus: string | undefined;
      try { process.kill(childPid, 0); } catch (error) { childStatus = (error as NodeJS.ErrnoException).code; }
      expect(childStatus).toBe("ESRCH");
      expect(readFileSync(signalFile, "utf8")).toBe("SIGTERM");
    } finally {
      clearTimeout(exitTimer);
      if (wrapper.exitCode === null) try { wrapper.kill("SIGKILL"); } catch { /* already exited */ }
      if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, "utf8"));
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, "SIGKILL"); } catch { /* child already exited */ }
        }
      }
      await Promise.race([wrapper.exited, Bun.sleep(1_000)]);
      removeTreeWithRetry(root);
    }
  }, 20_000);
});
