import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  createIsolatedTestEnvironment,
  resolveBunTestArgs,
  resolveBunTestPlan,
  SERIAL_FULL_SUITE_FILES,
} from "../scripts/test";
import {
  acquireTestRunLock,
  resolveBareTestRunIdentity,
  TEST_RUN_NO_QUEUE_ENV,
} from "../scripts/test-run-lock";
import {
  decodeWindowsIdentityPowerShellOutputForTests,
  windowsIdentityPowerShellCommandForTests,
  windowsIdentityPowerShellSpawnOptionsForTests,
} from "../src/codex/user-identity";

describe("test runner isolation", () => {
  test("redirects user homes to a disposable root", () => {
    const isolated = createIsolatedTestEnvironment({ PATH: "/test/bin", HOME: "/real/home" });
    try {
      expect(isolated.env).toMatchObject({
        PATH: "/test/bin",
        HOME: isolated.root,
        USERPROFILE: isolated.root,
        OPENCODEX_HOME: join(isolated.root, ".opencodex"),
        CODEX_HOME: join(isolated.root, ".codex"),
      });
      expect(existsSync(isolated.env.OPENCODEX_HOME!)).toBe(true);
      expect(existsSync(isolated.env.CODEX_HOME!)).toBe(true);
    } finally {
      isolated.cleanup();
    }
    expect(existsSync(isolated.root)).toBe(false);
  });

  test.if(process.platform === "win32")("gives the Windows sandbox a real profile shape", () => {
    const isolated = createIsolatedTestEnvironment({ PATH: "C:\\test\\bin" });
    try {
      expect(existsSync(join(isolated.root, "AppData", "Local"))).toBe(true);
      expect(existsSync(join(isolated.root, "AppData", "Roaming"))).toBe(true);
    } finally {
      isolated.cleanup();
    }
  });

  // The bug this pins: .NET's known-folder API resolves against USERPROFILE and returns an
  // EMPTY STRING — not an error — for a folder that does not exist. With the sandbox missing
  // AppData, `resolveWindowsRuntimeRoot` refused every Codex coordinator lookup with "Windows
  // effective-account lookup returned an empty value", and each refusal surfaced as an
  // unrelated assertion in whichever suite touched a Codex home.
  test.if(process.platform === "win32")(
    "keeps the .NET known-folder lookup resolvable inside the sandbox",
    () => {
      const isolated = createIsolatedTestEnvironment();
      try {
        const command = windowsIdentityPowerShellCommandForTests(
          "[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)",
        );
        const result = Bun.spawnSync(command, {
          ...windowsIdentityPowerShellSpawnOptionsForTests(),
          env: { ...process.env, USERPROFILE: isolated.root, HOME: isolated.root },
        });

        expect(result.exitCode).toBe(0);
        const localAppData = decodeWindowsIdentityPowerShellOutputForTests(
          result.stdout ?? new Uint8Array(),
        );
        expect(localAppData).not.toBe("");
        expect(isAbsolute(localAppData)).toBe(true);
        expect(localAppData.toLowerCase()).toStartWith(isolated.root.toLowerCase());
      } finally {
        isolated.cleanup();
      }
    },
  );
});

/**
 * Without `--parallel`, `--isolate` re-evaluates the module graph once per file on a single
 * core. Past ~900 files that stops reading as slow and starts reading as hung: measured at
 * 1 h 29 m with zero output, ~57 % CPU and 8.5 MB RSS. Four workers keep the suite inside a
 * few minutes without the deadline-sensitive failures observed when Bun selected all ten cores.
 * These pin the argv so the bound cannot be dropped again silently.
 */
describe("bun test argv", () => {
  test("a filter-less run gets isolate, bounded parallelism and the suite path", () => {
    expect(resolveBunTestArgs([])).toEqual(["--isolate", "--parallel=4", "./tests/"]);
  });

  test("the default full suite quarantines load-sensitive files into one-worker lanes", () => {
    const plan = resolveBunTestPlan([]);
    expect(plan).toHaveLength(SERIAL_FULL_SUITE_FILES.length + 1);
    expect(plan[0]?.label).toBe("parallel suite");
    expect(plan[0]?.args).toContain("--parallel=4");
    expect(plan[0]?.args).toContain("./tests/");
    for (const file of SERIAL_FULL_SUITE_FILES) {
      expect(plan[0]?.args).toContain(`**/${file}`);
      expect(plan.find(lane => lane.label === file)?.args).toEqual([
        "--isolate",
        "--parallel=1",
        `./tests/${file}`,
      ]);
    }
    expect(plan.find(lane => lane.label === "release-helper.test.ts")?.timeoutMs).toBe(5 * 60 * 1000);
    expect(plan.find(lane => lane.label === "codex-shim.test.ts")?.timeoutMs).toBe(3 * 60 * 1000);
  });

  test("serial lanes override caller parallelism without changing the main lane", () => {
    const plan = resolveBunTestPlan(["--parallel=2", "--only-failures"]);
    expect(plan[0]?.args).toContain("--parallel=2");
    for (const lane of plan.slice(1)) {
      expect(lane.args).toContain("--parallel=1");
      expect(lane.args).not.toContain("--parallel=2");
      expect(lane.args).toContain("--only-failures");
    }
  });

  test("sharded and reporter-file runs stay a single caller-controlled lane", () => {
    expect(resolveBunTestPlan(["--shard=1/3"])).toHaveLength(1);
    expect(resolveBunTestPlan(["--reporter=junit", "--reporter-outfile", "results.xml"]))
      .toHaveLength(1);
  });

  test("a file filter keeps isolate and bounded parallelism but no suite path", () => {
    expect(resolveBunTestArgs(["tests/foo.test.ts"]))
      .toEqual(["--isolate", "--parallel=4", "tests/foo.test.ts"]);
    expect(resolveBunTestArgs(["-"]))
      .toEqual(["--isolate", "--parallel=4", "-"]);
  });

  test("a caller-supplied concurrency is left alone", () => {
    expect(resolveBunTestArgs(["--parallel=2"]))
      .toEqual(["--isolate", "--parallel=2", "./tests/"]);
    expect(resolveBunTestArgs(["--parallel"]))
      .toEqual(["--isolate", "--parallel", "./tests/"]);
    expect(resolveBunTestArgs(["--parallel", "tests/foo.test.ts"]))
      .toEqual(["--isolate", "--parallel", "tests/foo.test.ts"]);
    expect(resolveBunTestArgs(["--parallel=2", "tests/foo.test.ts"]))
      .toEqual(["--isolate", "--parallel=2", "tests/foo.test.ts"]);
  });

  test("option-only arguments still count as a full suite run", () => {
    expect(resolveBunTestArgs(["--timeout=30000"]))
      .toEqual(["--isolate", "--parallel=4", "--timeout=30000", "./tests/"]);
    expect(resolveBunTestArgs(["--timeout", "30000"]))
      .toEqual(["--isolate", "--parallel=4", "--timeout", "30000", "./tests/"]);
    expect(resolveBunTestArgs(["--timeout", "30000", "tests/foo.test.ts"]))
      .toEqual(["--isolate", "--parallel=4", "--timeout", "30000", "tests/foo.test.ts"]);
    expect(resolveBunTestArgs(["--timings", ".bun-test-timings/current.json"]))
      .toEqual([
        "--isolate",
        "--parallel=4",
        "--timings",
        ".bun-test-timings/current.json",
        "./tests/",
      ]);
    for (const configFlag of ["-c", "--config"]) {
      expect(resolveBunTestArgs([configFlag, "ci.bunfig.toml"]))
        .toEqual(["--isolate", "--parallel=4", configFlag, "ci.bunfig.toml", "./tests/"]);
    }
    expect(resolveBunTestArgs(["-t", "serial test"])).toEqual([
      "--isolate",
      "--parallel=4",
      "-t",
      "serial test",
      "./tests/",
    ]);
  });

  test("arguments after the delimiter are passed through instead of parsed as wrapper flags", () => {
    expect(resolveBunTestArgs(["--", "--parallel=2"]))
      .toEqual(["--isolate", "--parallel=4", "--", "--parallel=2"]);
  });

  test("the wrapper passes parallel execution through to bun", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "opencodex-test-runner-"));
    const fixturePath = join(fixtureRoot, "parallel-smoke.test.ts");
    const markerPath = join(fixtureRoot, "executed.marker");
    writeFileSync(
      fixturePath,
      `import { test } from "bun:test"; import { writeFileSync } from "node:fs"; test("smoke", () => writeFileSync(${JSON.stringify(markerPath)}, "executed"));\n`,
    );
    try {
      const result = Bun.spawnSync([
        process.execPath,
        join(import.meta.dir, "../scripts/test.ts"),
        fixturePath,
      ], {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, OCX_TEST_NO_QUEUE: "1" },
        stdout: "pipe",
        stderr: "pipe",
      });

      const output = new TextDecoder().decode(result.stdout)
        + new TextDecoder().decode(result.stderr);
      expect(result.exitCode).toBe(0);
      expect(output).toContain("PARALLEL");
      expect(existsSync(markerPath)).toBe(true);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});

describe("bun test machine lock", () => {
  test("independent bare runners do not inherit a shared long-lived parent identity", () => {
    expect(resolveBareTestRunIdentity({ pid: 101, ppid: 50 })).toEqual({
      ownerPid: 101,
      runId: "bare-101",
    });
    expect(resolveBareTestRunIdentity({ pid: 102, ppid: 50 })).toEqual({
      ownerPid: 102,
      runId: "bare-102",
    });
  });

  test("parallel Bun workers rendezvous on their short-lived controller PID", () => {
    expect(resolveBareTestRunIdentity({ pid: 101, ppid: 90, workerId: "1" })).toEqual({
      ownerPid: 101,
      runId: "bare-90",
    });
    expect(resolveBareTestRunIdentity({ pid: 102, ppid: 90, workerId: "2" })).toEqual({
      ownerPid: 102,
      runId: "bare-90",
    });
  });

  test("one run owns the lock while sibling workers with its run ID join", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencodex-test-lock-"));
    const lockPath = join(root, "suite.lock");
    try {
      const owner = await acquireTestRunLock({ runId: "suite-a", lockPath, pollMs: 5, maxWaitMs: 50 });
      const sibling = await acquireTestRunLock({ runId: "suite-a", lockPath, pollMs: 5, maxWaitMs: 50 });
      expect(owner.acquired).toBe(true);
      expect(sibling.acquired).toBe(false);
      sibling.release();
      expect(existsSync(lockPath)).toBe(true);
      owner.release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a dead owner is reclaimed even when the next bare invocation derives the same run ID", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencodex-test-lock-"));
    const lockPath = join(root, "suite.lock");
    try {
      const stale = await acquireTestRunLock({
        runId: "stale",
        ownerPid: 2_147_483_647,
        lockPath,
        pollMs: 5,
        maxWaitMs: 50,
      });
      const replacement = await acquireTestRunLock({ runId: "stale", lockPath, pollMs: 5, maxWaitMs: 50 });
      expect(replacement.acquired).toBe(true);
      stale.release();
      expect(existsSync(lockPath)).toBe(true);
      replacement.release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a live competing run fails closed after the bounded wait", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencodex-test-lock-"));
    const lockPath = join(root, "suite.lock");
    try {
      const owner = await acquireTestRunLock({ runId: "live", lockPath, pollMs: 5, maxWaitMs: 50 });
      let waits = 0;
      await expect(acquireTestRunLock({
        runId: "blocked",
        lockPath,
        pollMs: 5,
        maxWaitMs: 20,
        onWait: () => { waits += 1; },
      })).rejects.toThrow("timed out");
      expect(waits).toBe(1);
      owner.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the explicit no-queue escape hatch does not create a lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencodex-test-lock-"));
    const lockPath = join(root, "suite.lock");
    try {
      const lock = await acquireTestRunLock({
        runId: "opt-out",
        lockPath,
        env: { [TEST_RUN_NO_QUEUE_ENV]: "1" },
      });
      expect(lock.acquired).toBe(false);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
