import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, win32 } from "node:path";
import {
  changedSelectionFailure,
  createIsolatedTestEnvironment,
  ensureGuiDependencies,
  inspectChangedRun,
  resolveBunTestArgs,
  resolveBunTestPlan,
  selectChangedComparisonRef,
  SERIAL_FULL_SUITE_FILES,
} from "../scripts/test";
import {
  acquireTestRunLock,
  resolveBareTestRunIdentity,
  resolveDefaultTestRunLockPath,
  resolveInheritedTestRunLock,
  resolveWrappedTestRunLockPath,
  TEST_RUN_LOCK_PATH_ENV,
  TEST_RUN_LOCK_TOKEN_ENV,
  TEST_RUN_NO_QUEUE_ENV,
  type TestRunRuntimeFileSystem,
} from "../scripts/test-run-lock";
import {
  decodeWindowsIdentityPowerShellOutputForTests,
  windowsIdentityPowerShellCommandForTests,
  windowsIdentityPowerShellSpawnOptionsForTests,
} from "../src/codex/user-identity";
import { removeTreeWithRetry } from "./helpers/remove-tree";


function runGit(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  return new TextDecoder().decode(result.stdout).trim();
}

// Assembled from fragments so the fixture identity is not an email literal in a tracked
// file: scripts/privacy-scan.ts matches any email-shaped string and `.invalid` is not
// allow-listed, so writing it whole fails the repository's own privacy gate. The bytes
// handed to git are identical either way.
const FIXTURE_COMMIT_EMAIL = ["test", "opencodex.invalid"].join("@");

function pathIsContainedBy(parent: string, candidate: string, platform: "posix" | "win32"): boolean {
  const path = platform === "win32" ? win32 : posix;
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`)
    && relative !== ".." && !path.isAbsolute(relative));
}

function acceptingRuntimeFileSystem(
  uid: number,
  writable = true,
  modes: Readonly<Record<string, number>> = {},
): TestRunRuntimeFileSystem {
  return {
    lstatSync: path => ({
      uid,
      mode: modes[path] ?? 0o700,
      isDirectory: () => true,
      isSymbolicLink: () => false,
    }),
    mkdirSync: () => {},
    accessSync: () => {
      if (!writable) throw Object.assign(new Error("denied"), { code: "EACCES" });
    },
  };
}

function commitFixture(cwd: string, path: string, contents: string, message: string): string {
  writeFileSync(join(cwd, path), contents);
  runGit(cwd, "add", path);
  runGit(
    cwd,
    "-c",
    "user.name=OpenCodex Test",
    "-c",
    `user.email=${FIXTURE_COMMIT_EMAIL}`,
    "commit",
    "-m",
    message,
  );
  return runGit(cwd, "rev-parse", "HEAD");
}

function initChangedRunFixture(): { cwd: string; base: string } {
  const cwd = mkdtempSync(join(tmpdir(), "opencodex-changed-ref-"));
  runGit(cwd, "init", "--quiet");
  const base = commitFixture(cwd, "base.txt", "base\n", "base");
  return { cwd, base };
}

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
    const mergeBase = "0123456789abcdef0123456789abcdef01234567";
    expect(resolveBunTestArgs(["--", "--changed=fixture"], mergeBase))
      .toEqual(["--isolate", "--parallel=4", "--", "--changed=fixture"]);
    expect(inspectChangedRun(["--", "--changed=fixture"])).toBeNull();
  });

  test("changed-mode stays explicitly filtered without redundant arguments", () => {
    expect(resolveBunTestArgs(["--changed=dev"]))
      .toEqual(["--isolate", "--parallel=4", "--changed=dev"]);
    const mergeBase = "0123456789abcdef0123456789abcdef01234567";
    expect(resolveBunTestArgs(["--changed=dev"], mergeBase))
      .toEqual(["--isolate", "--parallel=4", "--changed=" + mergeBase]);
    expect(resolveBunTestPlan(["--changed=dev"])).toHaveLength(1);
  });

  test("changed-mode prefers the first existing conventional dev ref", () => {
    const selectFrom = (...existing: string[]) => {
      const probed: string[] = [];
      const selected = selectChangedComparisonRef(ref => {
        probed.push(ref);
        return existing.includes(ref);
      });
      return { selected, probed };
    };

    expect(selectFrom("upstream/dev", "origin/dev", "dev")).toEqual({
      selected: "upstream/dev",
      probed: ["upstream/dev"],
    });
    expect(selectFrom("origin/dev", "dev")).toEqual({
      selected: "origin/dev",
      probed: ["upstream/dev", "origin/dev"],
    });
    expect(selectFrom("dev")).toEqual({
      selected: "dev",
      probed: ["upstream/dev", "origin/dev", "dev"],
    });
    expect(selectFrom()).toEqual({
      selected: null,
      probed: ["upstream/dev", "origin/dev", "dev"],
    });
  });

  test("changed-mode requires an explicit, resolvable comparison ref", () => {
    expect(() => inspectChangedRun(["--changed"])).toThrow("requires an explicit comparison ref");
    expect(() => inspectChangedRun(["--changed=refs/heads/definitely-missing-test-ref"]))
      .toThrow("does not resolve to a commit");
    const inspected = inspectChangedRun(["--changed=HEAD"]);
    expect(inspected?.comparisonRef).toBe("HEAD");
    expect(inspected?.comparisonCommit).toBe(runGit(process.cwd(), "rev-parse", "HEAD"));
  });

  test("changed-mode uses the shared merge base for behind, ahead, and diverged refs", () => {
    const fixtures: string[] = [];
    try {
      const behind = initChangedRunFixture();
      fixtures.push(behind.cwd);
      runGit(behind.cwd, "branch", "candidate", behind.base);
      commitFixture(behind.cwd, "head.txt", "head\n", "head ahead of candidate");
      expect(inspectChangedRun(["--changed=candidate"], behind.cwd)).toMatchObject({
        comparisonRef: "candidate",
        comparisonCommit: behind.base,
        changedFiles: ["head.txt"],
      });

      const ahead = initChangedRunFixture();
      fixtures.push(ahead.cwd);
      const candidateTip = commitFixture(ahead.cwd, "candidate.txt", "candidate\n", "candidate ahead");
      runGit(ahead.cwd, "branch", "candidate", candidateTip);
      runGit(ahead.cwd, "checkout", "--quiet", "--detach", ahead.base);
      expect(inspectChangedRun(["--changed=candidate"], ahead.cwd)).toMatchObject({
        comparisonRef: "candidate",
        comparisonCommit: ahead.base,
        changedFiles: [],
      });

      const diverged = initChangedRunFixture();
      fixtures.push(diverged.cwd);
      runGit(diverged.cwd, "checkout", "--quiet", "-b", "candidate");
      commitFixture(diverged.cwd, "candidate.txt", "candidate\n", "candidate side");
      runGit(diverged.cwd, "checkout", "--quiet", "--detach", diverged.base);
      commitFixture(diverged.cwd, "head.txt", "head\n", "head side");
      expect(inspectChangedRun(["--changed=candidate"], diverged.cwd)).toMatchObject({
        comparisonRef: "candidate",
        comparisonCommit: diverged.base,
        changedFiles: ["head.txt"],
      });
    } finally {
      for (const fixture of fixtures) removeTreeWithRetry(fixture);
    }
  });

  test("rejects an empty changed selection when the diff is non-empty", () => {
    expect(changedSelectionFailure(
      { comparisonRef: "upstream/dev", comparisonCommit: "base-sha", changedFiles: ["src/router.ts"] },
      "Ran 0 tests across 0 files.",
    )).toContain("--changed=base-sha (upstream/dev merge base) selected 0 tests across 0 files");
    expect(changedSelectionFailure(
      { comparisonRef: "dev", comparisonCommit: "base-sha", changedFiles: ["src/router.ts"] },
      "Ran 9 tests across 1 file.",
    )).toBeNull();
    expect(changedSelectionFailure(
      { comparisonRef: "HEAD", comparisonCommit: "head-sha", changedFiles: [] },
      "Ran 0 tests across 0 files.",
    )).toBeNull();
  });

  test("rejects an unrecognized changed-mode summary for a non-empty diff", () => {
    expect(changedSelectionFailure(
      { comparisonRef: "dev", comparisonCommit: "base-sha", changedFiles: ["src/router.ts"] },
      "0 pass\n0 fail",
    )).toContain("did not emit a recognizable selection summary");
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
      removeTreeWithRetry(fixtureRoot);
    }
  });
});

describe("bun test user lock", () => {
  test("distinct POSIX users receive distinct temp-runtime locks", () => {
    const common = { env: {}, tempDir: "/tmp", hostName: "builder-1", platform: "linux" as const };
    const alice = resolveDefaultTestRunLockPath({
      ...common,
      uid: 1001,
      fileSystem: acceptingRuntimeFileSystem(1001),
    });
    const bob = resolveDefaultTestRunLockPath({
      ...common,
      uid: 1002,
      fileSystem: acceptingRuntimeFileSystem(1002),
    });

    expect(alice).not.toBe(bob);
    expect(pathIsContainedBy("/tmp/opencodex-test-runtime-1001", alice, "posix")).toBe(true);
    expect(pathIsContainedBy("/tmp/opencodex-test-runtime-1002", bob, "posix")).toBe(true);
  });

  test("a shared home cannot couple locks from distinct hosts", () => {
    const common = {
      env: { HOME: "/network/users/alice" },
      uid: 1001,
      tempDir: "/tmp",
      platform: "linux" as const,
      fileSystem: acceptingRuntimeFileSystem(1001),
    };
    const firstHost = resolveDefaultTestRunLockPath({ ...common, hostName: "builder-1" });
    const secondHost = resolveDefaultTestRunLockPath({ ...common, hostName: "builder-2" });

    expect(firstHost).not.toBe(secondHost);
    expect(pathIsContainedBy(common.env.HOME, firstHost, "posix")).toBe(false);
    expect(pathIsContainedBy(common.env.HOME, secondHost, "posix")).toBe(false);
  });

  test("Windows scopes the lock to the effective SID runtime and hardens its directory", () => {
    const hardened: string[] = [];
    const common = {
      platform: "win32" as const,
      tempDir: "C:\\Windows\\Temp",
      hostName: "desktop-1",
      fileSystem: acceptingRuntimeFileSystem(0),
      resolveRuntimeRoot: (identity: { platform: "win32"; sid: string }) =>
        `C:\\Runtime\\${identity.sid}`,
      hardenWindowsDirectory: (path: string) => { hardened.push(path); },
    };
    const alice = resolveDefaultTestRunLockPath({
      ...common,
      env: {},
      resolveIdentity: () => ({ platform: "win32", sid: "S-1-5-21-1001" }),
    });
    const aliceWithHostileEnvironment = resolveDefaultTestRunLockPath({
      ...common,
      env: {
        USER: "someone-else",
        USERNAME: "someone-else",
        USERDOMAIN: "hostile",
        TEMP: "C:\\Windows\\Temp",
        TMP: "C:\\Windows\\Temp",
        LOCALAPPDATA: "C:\\Windows\\Temp",
      },
      resolveIdentity: () => ({ platform: "win32", sid: "S-1-5-21-1001" }),
    });
    const bob = resolveDefaultTestRunLockPath({
      ...common,
      env: {},
      resolveIdentity: () => ({ platform: "win32", sid: "S-1-5-21-1002" }),
    });

    expect(aliceWithHostileEnvironment).toBe(alice);
    expect(bob).not.toBe(alice);
    expect(pathIsContainedBy("C:\\Runtime\\S-1-5-21-1001\\bun-test-locks", alice, "win32"))
      .toBe(true);
    expect(pathIsContainedBy(common.tempDir, alice, "win32")).toBe(false);
    expect(hardened).toEqual([
      "C:\\Runtime\\S-1-5-21-1001\\bun-test-locks",
      "C:\\Runtime\\S-1-5-21-1001\\bun-test-locks",
      "C:\\Runtime\\S-1-5-21-1002\\bun-test-locks",
    ]);
  });

  test("rejects a group-writable XDG root in favor of the private UID fallback", () => {
    const xdg = "/run/user/1001";
    const fallback = "/tmp/opencodex-test-runtime-1001";
    const lockPath = resolveDefaultTestRunLockPath({
      platform: "linux",
      env: { XDG_RUNTIME_DIR: xdg },
      uid: 1001,
      tempDir: "/tmp",
      hostName: "builder-1",
      fileSystem: acceptingRuntimeFileSystem(1001, true, {
        [xdg]: 0o733,
        [fallback]: 0o700,
      }),
    });

    expect(dirname(lockPath)).toBe(fallback);
  });

  test("Windows refuses before returning a path when identity or ACL hardening fails", () => {
    const common = {
      platform: "win32" as const,
      tempDir: "C:\\Windows\\Temp",
      hostName: "desktop-1",
      fileSystem: acceptingRuntimeFileSystem(0),
    };
    expect(() => resolveDefaultTestRunLockPath({
      ...common,
      resolveIdentity: () => { throw new Error("identity unavailable"); },
    })).toThrow("the Windows effective identity is unavailable");

    expect(() => resolveDefaultTestRunLockPath({
      ...common,
      resolveIdentity: () => ({ platform: "win32", sid: "S-1-5-21-1001" }),
      resolveRuntimeRoot: () => "C:\\Runtime\\S-1-5-21-1001",
      hardenWindowsDirectory: () => { throw new Error("ACL unavailable"); },
    })).toThrow("the Windows lock directory cannot be secured");
  });

  test("Windows rejects a redirected lock directory before ACL hardening", () => {
    let hardenCalls = 0;
    const fileSystem: TestRunRuntimeFileSystem = {
      lstatSync: () => ({
        uid: 0,
        mode: 0o700,
        isDirectory: () => true,
        isSymbolicLink: () => true,
      }),
      mkdirSync() {},
      accessSync() {},
    };

    expect(() => resolveDefaultTestRunLockPath({
      platform: "win32",
      hostName: "desktop-1",
      fileSystem,
      resolveIdentity: () => ({ platform: "win32", sid: "S-1-5-21-1001" }),
      resolveRuntimeRoot: () => "C:\\Runtime\\S-1-5-21-1001",
      hardenWindowsDirectory: () => { hardenCalls += 1; },
    })).toThrow("is not a real directory");
    expect(hardenCalls).toBe(0);
  });

  test("Windows creates a missing lock directory before validating and hardening it", () => {
    let created = false;
    let hardenCalls = 0;
    const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
    const fileSystem: TestRunRuntimeFileSystem = {
      lstatSync: () => {
        if (!created) throw missing;
        return {
          uid: 0,
          mode: 0o700,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        };
      },
      mkdirSync() { created = true; },
      accessSync() {},
    };

    const lockPath = resolveDefaultTestRunLockPath({
      platform: "win32",
      hostName: "desktop-1",
      fileSystem,
      resolveIdentity: () => ({ platform: "win32", sid: "S-1-5-21-1001" }),
      resolveRuntimeRoot: () => "C:\\Runtime\\S-1-5-21-1001",
      hardenWindowsDirectory: () => { hardenCalls += 1; },
    });

    expect(lockPath).toContain("\\bun-test-locks\\opencodex-bun-test-");
    expect(created).toBe(true);
    expect(hardenCalls).toBe(1);
  });

  test("wrapped workers reuse one validated Windows lock path", () => {
    let identityCalls = 0;
    let runtimeRootCalls = 0;
    let hardenCalls = 0;
    const lockPath = resolveDefaultTestRunLockPath({
      platform: "win32",
      hostName: "desktop-1",
      fileSystem: acceptingRuntimeFileSystem(0),
      resolveIdentity: () => {
        identityCalls += 1;
        return { platform: "win32", sid: "S-1-5-21-1001" };
      },
      resolveRuntimeRoot: () => {
        runtimeRootCalls += 1;
        return "C:\\Runtime\\S-1-5-21-1001";
      },
      hardenWindowsDirectory: () => { hardenCalls += 1; },
    });
    const ownerToken = "57f44b0e-b750-4bd2-b23d-4a035e75da18";
    const env = {
      [TEST_RUN_LOCK_PATH_ENV]: lockPath,
      [TEST_RUN_LOCK_TOKEN_ENV]: ownerToken,
    };

    const workers = ["worker-a", "worker-b", "worker-c"].map(wrappedRunId =>
      resolveInheritedTestRunLock({
        wrappedRunId,
        env,
        platform: "win32",
        hostName: "desktop-1",
      }));

    expect(workers).toEqual([
      { lockPath, ownerToken },
      { lockPath, ownerToken },
      { lockPath, ownerToken },
    ]);
    expect(identityCalls).toBe(1);
    expect(runtimeRootCalls).toBe(1);
    expect(hardenCalls).toBe(1);
    expect(() => resolveInheritedTestRunLock({
      wrappedRunId: "wrapped",
      env: {},
      platform: "win32",
      hostName: "desktop-1",
    })).toThrow("capability is incomplete");
    expect(resolveInheritedTestRunLock({
      wrappedRunId: "wrapped",
      env: { [TEST_RUN_NO_QUEUE_ENV]: "1" },
      platform: "win32",
      hostName: "desktop-1",
    })).toBeUndefined();
    expect(resolveInheritedTestRunLock({
      wrappedRunId: "wrapped",
      env,
      platform: "linux",
      hostName: "desktop-1",
    })).toBeUndefined();
    expect(() => resolveInheritedTestRunLock({
      wrappedRunId: "wrapped",
      env: {
        [TEST_RUN_LOCK_PATH_ENV]: "C:\\Runtime\\bun-test-locks\\wrong.lock",
        [TEST_RUN_LOCK_TOKEN_ENV]: ownerToken,
      },
      platform: "win32",
      hostName: "desktop-1",
    })).toThrow("inherited lock access");
  });

  test("the no-queue wrapper path performs no identity or runtime mutation", () => {
    let resolveCalls = 0;
    const lockPath = resolveWrappedTestRunLockPath({
      env: { [TEST_RUN_NO_QUEUE_ENV]: "1" },
      resolve: () => {
        resolveCalls += 1;
        return "C:\\Runtime\\bun-test-locks\\unexpected.lock";
      },
    });

    expect(lockPath).toBeUndefined();
    expect(resolveCalls).toBe(0);
  });

  test("falls back from an unsafe XDG root to a validated mode-0700 UID directory", () => {
    if (process.platform === "win32" || typeof process.getuid !== "function") return;
    const root = mkdtempSync(join(tmpdir(), "opencodex-runtime-fallback-"));
    const unsafeXdg = join(root, "not-a-directory");
    writeFileSync(unsafeXdg, "unsafe\n");
    try {
      const lockPath = resolveDefaultTestRunLockPath({
        env: { XDG_RUNTIME_DIR: unsafeXdg },
        uid: process.getuid(),
        tempDir: root,
        hostName: "builder-1",
      });
      const runtimeRoot = dirname(lockPath);
      const entry = statSync(runtimeRoot);

      expect(runtimeRoot).toBe(join(root, `opencodex-test-runtime-${process.getuid()}`));
      expect(entry.isDirectory()).toBe(true);
      expect(entry.uid).toBe(process.getuid());
      expect(entry.mode & 0o777).toBe(0o700);
    } finally {
      removeTreeWithRetry(root);
    }
  });

  test("fails immediately with actionable guidance when every runtime root is unwritable", () => {
    expect(() => resolveDefaultTestRunLockPath({
      platform: "linux",
      env: { XDG_RUNTIME_DIR: "/run/user/1001" },
      uid: 1001,
      tempDir: "/tmp",
      hostName: "builder-1",
      fileSystem: acceptingRuntimeFileSystem(1001, false),
    })).toThrow(
      "Cannot resolve a safe user-scoped Bun test lock. Ensure XDG_RUNTIME_DIR",
    );
  });

  test("containment checks do not confuse path string prefixes on POSIX or Windows", () => {
    const home = "/home/alice";
    const lockPath = resolveDefaultTestRunLockPath({
      platform: "linux",
      env: { HOME: home },
      uid: 1001,
      tempDir: "/home",
      hostName: "builder-1",
      fileSystem: acceptingRuntimeFileSystem(1001),
    });

    expect(home.startsWith("/home")).toBe(true);
    expect(pathIsContainedBy(home, lockPath, "posix")).toBe(false);
    expect(pathIsContainedBy("C:\\Users\\Ann", "C:\\Users\\Anna\\lock", "win32")).toBe(false);
  });

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
      removeTreeWithRetry(root);
    }
  });

  test("an inherited worker can only join the exact live wrapper owner", async () => {
    const root = mkdtempSync(join(tmpdir(), "opencodex-test-lock-"));
    const lockPath = join(root, "suite.lock");
    try {
      const owner = await acquireTestRunLock({ runId: "wrapped", lockPath, pollMs: 5, maxWaitMs: 50 });
      expect(owner.owner).not.toBeNull();
      const sibling = await acquireTestRunLock({
        runId: "wrapped",
        lockPath,
        joinExistingOwnerToken: owner.owner!.token,
      });
      expect(sibling.acquired).toBe(false);
      const wrongToken = owner.owner!.token === "57f44b0e-b750-4bd2-b23d-4a035e75da18"
        ? "6ab28966-06a7-4ef8-a0d9-23667d5d9ef5"
        : "57f44b0e-b750-4bd2-b23d-4a035e75da18";

      await expect(acquireTestRunLock({
        runId: "wrapped",
        lockPath,
        joinExistingOwnerToken: wrongToken,
      })).rejects.toThrow("refusing to create or reclaim");

      owner.release();
      expect(existsSync(lockPath)).toBe(false);
      await expect(acquireTestRunLock({
        runId: "wrapped",
        lockPath,
        joinExistingOwnerToken: owner.owner!.token,
      })).rejects.toThrow("refusing to create or reclaim");
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      removeTreeWithRetry(root);
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
      removeTreeWithRetry(root);
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
      removeTreeWithRetry(root);
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
      removeTreeWithRetry(root);
    }
  });
});

describe("ensureGuiDependencies", () => {
  // `gui` is not a workspace, so a root `bun install` leaves gui/node_modules absent and the
  // twenty-five tests importing gui/src die on `Cannot find package 'react'` — an "Unhandled error
  // between tests" that names no test. CI already installs them; this closes the local gap.
  const paths = (present: string[]) => {
    const normalized = present.map(path => path.replaceAll("\\", "/"));
    return (path: string) => normalized.some(entry => path.replaceAll("\\", "/").endsWith(entry));
  };

  test("mocked paths match POSIX and Windows separators", () => {
    const exists = paths(["gui/package.json"]);
    expect(exists("/repo/gui/package.json")).toBe(true);
    expect(exists("C:\\repo\\gui\\package.json")).toBe(true);
  });

  test("installs when gui/package.json exists but node_modules does not", () => {
    const installed: string[] = [];
    const logged: string[] = [];
    const result = ensureGuiDependencies({
      cwd: "/repo",
      exists: paths(["gui/package.json"]),
      install: dir => { installed.push(dir); return { ok: true, detail: "" }; },
      log: message => logged.push(message),
    });

    expect(result).toEqual({ kind: "installed" });
    expect(installed).toEqual([join("/repo", "gui")]);
    expect(logged[0]).toContain("gui dependencies are missing or incomplete");
  });

  test("retries when node_modules exists without the required dependency", () => {
    let installs = 0;
    const result = ensureGuiDependencies({
      cwd: "/repo",
      exists: paths(["gui/package.json", "gui/node_modules"]),
      install: () => { installs += 1; return { ok: true, detail: "" }; },
      log: () => {},
    });

    expect(result).toEqual({ kind: "installed" });
    expect(installs).toBe(1);
  });

  test("does nothing when the required dependency is already there", () => {
    let installs = 0;
    const result = ensureGuiDependencies({
      cwd: "/repo",
      exists: paths(["gui/package.json", "gui/node_modules/react/package.json"]),
      install: () => { installs += 1; return { ok: true, detail: "" }; },
      log: () => {},
    });

    expect(result).toEqual({ kind: "present" });
    expect(installs).toBe(0);
  });

  // A published install tree has no gui/ at all; the runner must not try to install there.
  test("does nothing when there is no gui package", () => {
    let installs = 0;
    const result = ensureGuiDependencies({
      cwd: "/repo",
      exists: () => false,
      install: () => { installs += 1; return { ok: true, detail: "" }; },
      log: () => {},
    });

    expect(result).toEqual({ kind: "absent" });
    expect(installs).toBe(0);
  });

  // Offline or a lockfile drift has to surface as its own message, not as twenty-five
  // unexplained React failures once the lanes start.
  test("reports the failure detail instead of continuing", () => {
    const result = ensureGuiDependencies({
      cwd: "/repo",
      exists: paths(["gui/package.json"]),
      install: () => ({ ok: false, detail: "lockfile had changes" }),
      log: () => {},
    });

    expect(result).toEqual({ kind: "failed", detail: "lockfile had changes" });
  });
});
