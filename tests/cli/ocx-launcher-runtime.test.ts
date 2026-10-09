import { describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bundledBunPath } from "../../src/lib/bun-runtime";
import { findDesktopCli, findPathBun, type PathBunIo } from "../../src/lib/bun-path-runtime.mjs";
import { REAL_BUN_MIN_BYTES } from "../../src/lib/bun-binary-validator.mjs";
import { killProxy } from "../../src/lib/process-control";
import { repoPath } from "../helpers/repo-root";

const BIN_OCX = repoPath("bin", "ocx.mjs");
const nodeAvailable = spawnSync("node", ["--version"], {
  stdio: "ignore",
  windowsHide: true,
}).status === 0;
const runnable = process.platform === "win32" && nodeAvailable;

// /healthz is the launcher's first trustworthy end-to-end startup signal: a
// live Node parent or Bun child does not prove that the proxy is serving. The
// old 25s budget expired on a loaded Windows runner, and equivalent real-proxy
// starts elsewhere in this suite have taken 46-47s. 90s is more than twice the
// measured high-water mark while still turning a hung launch into a bounded
// failure. Keep the case budget derived so process inspection and cleanup have
// their own headroom after readiness settles.
const PROXY_HEALTH_TIMEOUT_MS = 90_000;
const EFFECTIVE_RUNTIME_TEST_TIMEOUT_MS = PROXY_HEALTH_TIMEOUT_MS + 30_000;

type Health = {
  status: string;
  service: string;
  pid: number;
  port: number;
};

type WindowsProcessIdentity = {
  pid: number;
  parentPid: number;
  executablePath: string;
  creationDate: string;
};

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolvePort(port) : reject(new Error("no port"))));
    });
  });
}

async function healthAt(port: number): Promise<Health | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(800),
    });
    if (!response.ok) return null;
    const body = await response.json() as Health;
    return body?.status === "ok"
      && body.service === "opencodex"
      && Number.isSafeInteger(body.pid)
      && body.pid > 0
      && body.port === port
      ? body
      : null;
  } catch {
    return null;
  }
}

async function waitForHealth(
  port: number,
  deadlineMs: number,
  launcher: ChildProcess,
): Promise<Health | null> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (launcher.exitCode !== null) return null;
    const health = await healthAt(port);
    if (health) return health;
    await Bun.sleep(200);
  }
  return null;
}

function windowsProcessIdentity(pid: number): WindowsProcessIdentity | null {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $p = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\"; if ($null -ne $p) { $p | Select-Object ProcessId, ParentProcessId, ExecutablePath, CreationDate | ConvertTo-Json -Compress }`,
    ],
    { encoding: "utf8", timeout: 10_000, windowsHide: true },
  );
  if (result.status !== 0) throw new Error(`could not inspect process identity: ${result.stderr.trim()}`);
  if (!result.stdout.trim()) return null;
  const value = JSON.parse(result.stdout) as {
    ProcessId?: number;
    ParentProcessId?: number;
    ExecutablePath?: string;
    CreationDate?: string;
  };
  if (
    !Number.isSafeInteger(value.ProcessId)
    || !Number.isSafeInteger(value.ParentProcessId)
    || typeof value.ExecutablePath !== "string"
    || typeof value.CreationDate !== "string"
  ) {
    throw new Error("process identity response was incomplete");
  }
  return {
    pid: value.ProcessId!,
    parentPid: value.ParentProcessId!,
    executablePath: value.ExecutablePath,
    creationDate: value.CreationDate,
  };
}

function canonicalWindowsPath(path: string): string {
  try {
    return realpathSync.native(path).toLowerCase();
  } catch {
    return resolve(path).toLowerCase();
  }
}

function sameWindowsPath(actual: string, expected: string): boolean {
  return canonicalWindowsPath(actual) === canonicalWindowsPath(expected);
}

function sameProcess(actual: WindowsProcessIdentity | null, expected: WindowsProcessIdentity): boolean {
  return actual !== null
    && actual.pid === expected.pid
    && actual.creationDate === expected.creationDate
    && sameWindowsPath(actual.executablePath, expected.executablePath);
}

function captureWindowsProcessIdentity(pid: number): WindowsProcessIdentity {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const identity = windowsProcessIdentity(pid);
      if (identity) return identity;
    } catch (error) {
      lastError = error;
    }
    Bun.sleepSync(100);
  }
  throw new Error(`could not capture process identity for PID ${pid}: ${String(lastError ?? "process not found")}`);
}

function inspectWindowsProcessIdentity(pid: number): WindowsProcessIdentity | null {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return windowsProcessIdentity(pid);
    } catch (error) {
      lastError = error;
      Bun.sleepSync(100);
    }
  }
  throw lastError;
}

function removeTree(path: string): void {
  // Windows can retain the copied executable's image handle briefly after
  // taskkill returns. Retry only transient fixture-cleanup errors, with a cap.
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
      if (!new Set(["EPERM", "EBUSY", "ENOTEMPTY"]).has(code)) throw error;
      lastError = error;
      Bun.sleepSync(200);
    }
  }
  throw lastError;
}

async function effectiveRuntime(override: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "ocx-launcher-runtime-"));
  let port: number | null = null;
  let launcher: ChildProcess | null = null;
  let launcherPid: number | null = null;
  let ownedLauncher: WindowsProcessIdentity | null = null;
  let ownedProxy: WindowsProcessIdentity | null = null;
  let runtimePath: string | undefined;
  let hasPrimaryError = false;
  let primaryError: unknown;
  try {
    port = await freePort();
    launcher = spawn("node", [BIN_OCX, "start", "--port", String(port)], {
      stdio: "ignore",
      windowsHide: true,
      env: isolatedLauncherEnv(root, override),
    });
    if (!launcher.pid) throw new Error("Node launcher has no process id");
    launcherPid = launcher.pid;
    ownedLauncher = captureWindowsProcessIdentity(launcherPid);

    const health = await waitForHealth(port, PROXY_HEALTH_TIMEOUT_MS, launcher);
    if (!health) throw new Error("proxy did not become healthy");
    const identity = windowsProcessIdentity(health.pid);
    if (!identity || identity.parentPid !== launcher.pid) {
      throw new Error("health PID is not the spawned Node launcher's direct Bun child");
    }
    ownedProxy = identity;
    runtimePath = identity.executablePath;
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
  }

  const cleanupErrors: string[] = [];
  let launcherTreeStopped = false;

  // Prefer the creation-time/path identity. If the initial CIM capture failed,
  // the live ChildProcess handle and its PID are still positive ownership of
  // this test's launcher, so terminate that exact process tree as a fallback.
  if (ownedLauncher) {
    try {
      if (sameProcess(inspectWindowsProcessIdentity(ownedLauncher.pid), ownedLauncher)) {
        killProxy(ownedLauncher.pid);
        launcherTreeStopped = true;
      }
    } catch (error) {
      cleanupErrors.push(`launcher cleanup failed: ${String(error)}`);
    }
  }
  if (!launcherTreeStopped && launcher && launcherPid && launcher.exitCode === null && launcher.signalCode === null) {
    try {
      killProxy(launcherPid);
      launcherTreeStopped = true;
    } catch (error) {
      cleanupErrors.push(`launcher tree fallback failed: ${String(error)}`);
    }
  }

  // The launcher tree kill normally removes the Bun child. Retain the
  // identity-verified proxy fallback in case the launcher exited first.
  if (ownedProxy) {
    try {
      if (sameProcess(inspectWindowsProcessIdentity(ownedProxy.pid), ownedProxy)) {
        killProxy(ownedProxy.pid);
      }
    } catch (error) {
      cleanupErrors.push(`proxy cleanup failed: ${String(error)}`);
    }
  }

  // Inspection failures are reported, but never prevent the remaining
  // process checks or fixture cleanup from running.
  for (const [label, identity] of [
    ["launcher", ownedLauncher],
    ["proxy", ownedProxy],
  ] as const) {
    if (!identity) continue;
    try {
      if (sameProcess(inspectWindowsProcessIdentity(identity.pid), identity)) {
        cleanupErrors.push(`owned ${label} PID ${identity.pid} remained after bounded cleanup`);
      }
    } catch (error) {
      cleanupErrors.push(`${label} cleanup verification failed: ${String(error)}`);
    }
  }
  if (port !== null) {
    const lingeringProxy = await healthAt(port);
    if (lingeringProxy) {
      cleanupErrors.push(`OpenCodex proxy PID ${lingeringProxy.pid} remained on owned port ${port}`);
    }
  }
  try {
    removeTree(root);
  } catch (error) {
    cleanupErrors.push(`fixture cleanup failed: ${String(error)}`);
  }

  if (hasPrimaryError) {
    if (cleanupErrors.length > 0) console.error(`additional cleanup errors: ${cleanupErrors.join("; ")}`);
    throw primaryError;
  }
  if (cleanupErrors.length > 0) throw new Error(cleanupErrors.join("; "));
  if (!runtimePath) throw new Error("proxy runtime path was not captured");
  return runtimePath;
}

function isolatedLauncherEnv(root: string, override: string): NodeJS.ProcessEnv {
  const opencodexHome = join(root, "opencodex");
  const codexHome = join(root, "codex");
  const grokHome = join(root, "grok");
  mkdirSync(opencodexHome, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(grokHome, { recursive: true });
  return {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    OPENCODEX_HOME: opencodexHome,
    CODEX_HOME: codexHome,
    GROK_HOME: grokHome,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    XDG_CACHE_HOME: join(root, "cache"),
    OPENCODEX_BUN_PATH: override,
  };
}

describe.skipIf(!nodeAvailable)("ocx package launcher relative Bun override", () => {
  test("resolves a valid bare relative override before spawning", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-launcher-relative-"));
    try {
      const overrideName = `custom-bun${process.platform === "win32" ? ".exe" : ""}`;
      const override = join(root, overrideName);
      copyFileSync(process.execPath, override);
      chmodSync(override, 0o755);

      const result = spawnSync("node", [BIN_OCX, "--version"], {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
        env: isolatedLauncherEnv(root, overrideName),
      });

      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain("OPENCODEX_BUN_PATH is missing");
    } finally {
      removeTree(root);
    }
  }, 60_000);

  test("warns without exposing the rejected override path before bundled fallback", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-launcher-invalid-"));
    try {
      const overrideName = `stub-bun${process.platform === "win32" ? ".exe" : ""}`;
      writeFileSync(join(root, overrideName), "not a Bun executable", "utf8");

      const result = spawnSync("node", [BIN_OCX, "--version"], {
        cwd: root,
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
        env: isolatedLauncherEnv(root, overrideName),
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("OPENCODEX_BUN_PATH is missing, unreadable, or not a complete Bun binary");
      expect(result.stderr).not.toContain(root);
    } finally {
      removeTree(root);
    }
  }, 60_000);
});

describe.skipIf(!runnable)("ocx package launcher effective Bun runtime", () => {
  test("uses a valid OPENCODEX_BUN_PATH for the actual proxy process", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-launcher-runtime-copy-"));
    try {
      const override = join(root, "override-bun.exe");
      copyFileSync(process.execPath, override);
      expect(sameWindowsPath(await effectiveRuntime(override), override)).toBe(true);
    } finally {
      removeTree(root);
    }
  }, EFFECTIVE_RUNTIME_TEST_TIMEOUT_MS);

  test("falls back to bundled Bun for a sub-1MB override stub", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-launcher-runtime-stub-"));
    try {
      const stub = join(root, "stub-bun.exe");
      writeFileSync(stub, "not a Bun executable", "utf8");
      const bundled = bundledBunPath();
      expect(bundled).not.toBeNull();
      expect(sameWindowsPath(await effectiveRuntime(stub), bundled!)).toBe(true);
    } finally {
      removeTree(root);
    }
  }, EFFECTIVE_RUNTIME_TEST_TIMEOUT_MS);
});

function pathProbeFixture(platform: NodeJS.Platform = "linux", stdout = "1.4.0\n") {
  const calls: Array<{ path: string; args: string[]; timeout: number; shell: boolean; maxBuffer: number }> = [];
  let clock = 0;
  const io: PathBunIo = {
    now: () => clock,
    realpath: path => path,
    stat: () => ({ isFile: () => true, mode: 0o755 }),
    access: () => {},
    isRealBunBinary: () => true,
    spawnSync: (path, args, options) => {
      calls.push({ path, args, timeout: options.timeout, shell: options.shell, maxBuffer: options.maxBuffer });
      return { status: 0, stdout };
    },
  };
  return { calls, io, advance: (ms: number) => { clock += ms; },
    find: (env: NodeJS.ProcessEnv, pinnedVersion = "1.4.2", deadlineMs = 750) =>
      findPathBun({ env, platform, pinnedVersion, deadlineMs, io }) };
}

describe("validated PATH Bun policy", () => {
  test.each(["1.4.0", "1.4.2", "1.5.0", "1.99.999", "1.4.0+build.1"])("accepts stable %s on the pinned major", version => {
    const fixture = pathProbeFixture("linux", version + "\n");
    expect(fixture.find({ PATH: "/trusted/bin" })).toEqual({ path: "/trusted/bin/bun", version });
    expect(fixture.calls).toEqual([
      { path: "/trusted/bin/bun", args: ["--version"], timeout: 750, shell: false, maxBuffer: 4096 },
      { path: "/trusted/bin/bun", args: ["-e", "process.stdout.write(String(typeof Bun==='object'&&Bun.version))"], timeout: 750, shell: false, maxBuffer: 4096 },
    ]);
  });
  test.each(["1.3.99", "2.0.0", "0.99.0", "1.4.0-canary", "v1.4.0", "1.4", "01.4.0", "1.4.0\nnoise", "1.4.0\u001b[31m"])("rejects %s", version => {
    expect(pathProbeFixture("linux", version).find({ PATH: "/trusted/bin" })).toBeNull();
  });
  test("skips empty relative and tilde PATH entries before filesystem access", () => {
    const fixture = pathProbeFixture();
    expect(fixture.find({ PATH: ":.:relative:~/bin:/trusted/bin" })?.path).toBe("/trusted/bin/bun");
    expect(fixture.calls.map(call => call.path)).toEqual(["/trusted/bin/bun", "/trusted/bin/bun"]);
  });
  test("Windows uses case-insensitive Path and only a rooted bun.exe", () => {
    const fixture = pathProbeFixture("win32");
    expect(fixture.find({ Path: ";C:relative;\\relative;C:\\trusted\\bin", PATHEXT: ".CMD;.BAT;.EXE" })?.path).toBe("C:\\trusted\\bin\\bun.exe");
    expect(fixture.calls.map(call => call.path)).toEqual(["C:\\trusted\\bin\\bun.exe", "C:\\trusted\\bin\\bun.exe"]);
  });
  test.each(["directory", "unexecutable", "stub", "realpath-error", "stat-error"])("does not spawn a %s candidate", kind => {
    const fixture = pathProbeFixture();
    if (kind === "directory") fixture.io.stat = () => ({ isFile: () => false, mode: 0o755 });
    if (kind === "unexecutable") fixture.io.access = () => { throw new Error("EACCES"); };
    if (kind === "stub") fixture.io.isRealBunBinary = () => false;
    if (kind === "realpath-error") fixture.io.realpath = () => { throw new Error("ENOENT"); };
    if (kind === "stat-error") fixture.io.stat = () => { throw new Error("EIO"); };
    expect(fixture.find({ PATH: "/bad" })).toBeNull();
    expect(fixture.calls).toEqual([]);
  });
  test.each(["exit", "signal", "error", "overflow"])("rejects a %s version probe", kind => {
    const fixture = pathProbeFixture();
    fixture.io.spawnSync = () => kind === "exit" ? { status: 1, stdout: "1.4.0" }
      : kind === "signal" ? { status: null, signal: "SIGKILL", stdout: "1.4.0" }
      : { status: null, error: new Error(kind) };
    expect(fixture.find({ PATH: "/bad" })).toBeNull();
  });
  test("shares one deadline across candidates and stops after timeout", () => {
    const fixture = pathProbeFixture();
    fixture.io.spawnSync = (path, args, options) => {
      fixture.calls.push({ path, args, timeout: options.timeout, shell: options.shell, maxBuffer: options.maxBuffer });
      fixture.advance(750);
      return { status: null, error: new Error("ETIMEDOUT") };
    };
    expect(fixture.find({ PATH: "/first:/second" })).toBeNull();
    expect(fixture.calls).toHaveLength(1);
  });
  test("canonical aliases are probed only once before the next candidate", () => {
    const fixture = pathProbeFixture();
    fixture.io.realpath = path => path.includes("alias") ? "/first/bun" : path;
    fixture.io.spawnSync = (path, args, options) => {
      fixture.calls.push({ path, args, timeout: options.timeout, shell: options.shell, maxBuffer: options.maxBuffer });
      fixture.advance(100);
      return { status: 0, stdout: path === "/last/bun" ? "1.4.0" : "1.3.0" };
    };
    expect(fixture.find({ PATH: "/first:/alias:/last" })?.path).toBe("/last/bun");
    expect(fixture.calls.map(call => call.timeout)).toEqual([750, 650, 550]);
  });
  test.each(["", "^1.4.2", "1.4.2-canary", "unknown"])("invalid package pin %s does not probe PATH", pin => {
    const fixture = pathProbeFixture();
    expect(fixture.find({ PATH: "/trusted/bin" }, pin)).toBeNull();
    expect(fixture.calls).toEqual([]);
  });
  test("threshold changes derive from the package pin", () => {
    expect(pathProbeFixture("linux", "1.4.0").find({ PATH: "/bin" }, "1.5.2")).toBeNull();
    expect(pathProbeFixture("linux", "2.0.0").find({ PATH: "/bin" }, "2.0.9")?.version).toBe("2.0.0");
  });
});

describe("failure-only Desktop CLI pointer", () => {
  test.each(["linux", "win32"] as const)("%s performs no app filesystem lookup", platform => {
    expect(findDesktopCli({ platform, io: { stat: () => { throw new Error("must not read"); } } })).toBeNull();
  });
  test("macOS checks executable system app before executable user app", () => {
    const visited: string[] = [];
    const result = findDesktopCli({ platform: "darwin", home: "/user", io: {
      stat: path => { visited.push(path); return { isFile: () => true }; },
      access: path => { if (path.startsWith("/Applications/")) throw new Error("EACCES"); },
    } });
    expect(result).toBe("/user/Applications/OpenCodex.app/Contents/MacOS/ocx");
    expect(visited).toEqual(["/Applications/OpenCodex.app/Contents/MacOS/ocx", result!]);
  });
  test("macOS omits a missing or directory app CLI", () => {
    expect(findDesktopCli({ platform: "darwin", io: { stat: () => { throw new Error("ENOENT"); } } })).toBeNull();
    expect(findDesktopCli({ platform: "darwin", io: { stat: () => ({ isFile: () => false }) } })).toBeNull();
  });
});

describe("real PATH Bun validation", () => {
  test.each(["file-group", "file-world", "parent-group", "parent-world"])("rejects POSIX %s write access before spawning", kind => {
    const fixture = pathProbeFixture();
    fixture.io.stat = path => ({
      isFile: () => true,
      mode: 0o755 | ((kind.startsWith("file") === path.endsWith("/bun"))
        ? (kind.endsWith("group") ? 0o020 : 0o002) : 0),
    });
    expect(fixture.find({ PATH: "/unsafe" })).toBeNull();
    expect(fixture.calls).toHaveLength(0);
  });

  test("Windows does not interpret POSIX write mode bits", () => {
    const fixture = pathProbeFixture("win32");
    fixture.io.stat = () => ({ isFile: () => true, mode: 0o777 });
    expect(fixture.find({ Path: "C:\\trusted" })?.version).toBe("1.4.0");
  });

  test.each(["false", "1.4.1", "1.4.0\nnoise", ""])("rejects a mismatched identity response %j", identity => {
    const fixture = pathProbeFixture();
    fixture.io.spawnSync = (_path, args) => ({ status: 0, stdout: args[0] === "--version" ? "1.4.0" : identity });
    expect(fixture.find({ PATH: "/candidate" })).toBeNull();
  });

  test.each(["exit", "signal", "error", "overflow", "throw"])("rejects a failed %s identity probe", kind => {
    const fixture = pathProbeFixture();
    fixture.io.spawnSync = (_path, args) => {
      if (args[0] === "--version") return { status: 0, stdout: "1.4.0" };
      if (kind === "throw") throw new Error("spawn failure");
      if (kind === "exit") return { status: 1, stdout: "1.4.0" };
      if (kind === "signal") return { status: null, signal: "SIGKILL", stdout: "1.4.0" };
      if (kind === "overflow") return { status: 0, stdout: "1.4.0" + " ".repeat(4096) };
      return { status: null, error: new Error("probe failure") };
    };
    expect(fixture.find({ PATH: "/candidate" })).toBeNull();
  });

  test("both probes and later candidates consume one shared deadline", () => {
    const fixture = pathProbeFixture();
    fixture.io.spawnSync = (path, args, options) => {
      fixture.calls.push({ path, args, timeout: options.timeout, shell: options.shell, maxBuffer: options.maxBuffer });
      fixture.advance(200);
      return { status: 0, stdout: args[0] === "--version" || path === "/last/bun" ? "1.4.0" : "false" };
    };
    expect(fixture.find({ PATH: "/first:/last" })).toBeNull();
    expect(fixture.calls.map(call => call.timeout)).toEqual([750, 550, 350, 150]);
  });

  test("identity receives the remaining budget and succeeds before the deadline", () => {
    const fixture = pathProbeFixture();
    fixture.io.spawnSync = (path, args, options) => {
      fixture.calls.push({ path, args, timeout: options.timeout, shell: options.shell, maxBuffer: options.maxBuffer });
      fixture.advance(100);
      return { status: 0, stdout: "1.4.0" };
    };
    expect(fixture.find({ PATH: "/trusted" })?.version).toBe("1.4.0");
    expect(fixture.calls.map(call => call.timeout)).toEqual([750, 650]);
  });

  test("skips non-absolute PATH entries before even resolving them", () => {
    const fixture = pathProbeFixture();
    const visited: string[] = [];
    fixture.io.realpath = path => { visited.push(path); return path; };
    expect(fixture.find({ PATH: ":.:relative:~/bin:/trusted" })?.path).toBe("/trusted/bun");
    expect(visited).toEqual(["/trusted/bun"]);
  });

  test("Windows accepts UNC bun.exe and deduplicates case aliases", () => {
    const fixture = pathProbeFixture("win32");
    fixture.io.spawnSync = (path, args, options) => {
      fixture.calls.push({ path, args, timeout: options.timeout, shell: options.shell, maxBuffer: options.maxBuffer });
      return { status: 0, stdout: path.startsWith("\\\\") ? "1.4.0" : "1.3.0" };
    };
    expect(fixture.find({ Path: "C:\\first;c:\\FIRST;\\\\host\\share" })?.path).toBe("\\\\host\\share\\bun.exe");
    expect(fixture.calls.map(call => call.path)).toEqual(["C:\\first\\bun.exe", "\\\\host\\share\\bun.exe", "\\\\host\\share\\bun.exe"]);
  });

  test.skipIf(process.platform === "win32")("real padded version-only script fails the identity check", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-path-identity-"));
    try {
      const path = join(root, "bun");
      writeFileSync(path, '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "1.4.0\\n"; else exit 1; fi\n#' + "x".repeat(REAL_BUN_MIN_BYTES));
      chmodSync(path, 0o755);
      expect(findPathBun({ env: { PATH: root }, pinnedVersion: "1.4.2", deadlineMs: 2000 })).toBeNull();
    } finally { removeTree(root); }
  });

  test.skipIf(process.platform === "win32")("real writable file and resolved parent are rejected", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-path-mode-"));
    try {
      const path = join(root, "bun");
      writeFileSync(path, '#!/bin/sh\nprintf "1.4.0\\n"\n#' + "x".repeat(REAL_BUN_MIN_BYTES));
      chmodSync(path, 0o777);
      const find = () => findPathBun({ env: { PATH: root }, pinnedVersion: "1.4.2", deadlineMs: 2000 });
      expect(find()).toBeNull();
      chmodSync(path, 0o755);
      chmodSync(root, 0o777);
      expect(find()).toBeNull();
    } finally { removeTree(root); }
  });

  test("real PATH validation rejects the small stub and accepts the complete executable", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-path-bun-"));
    try {
      const first = join(root, "first"), last = join(root, "last");
      mkdirSync(first); mkdirSync(last);
      const name = process.platform === "win32" ? "bun.exe" : "bun";
      writeFileSync(join(first, name), "not bun");
      if (process.platform === "win32") copyFileSync(process.execPath, join(last, name));
      else writeFileSync(join(last, name), '#!/bin/sh\ncase "$1" in --version|-e) printf "1.4.0\\n";; *) exit 1;; esac\n#' + "x".repeat(REAL_BUN_MIN_BYTES));
      chmodSync(join(first, name), 0o755); chmodSync(join(last, name), 0o755);
      const selected = findPathBun({ env: { ...process.env, PATH: [first, last].join(process.platform === "win32" ? ";" : ":") }, pinnedVersion: "1.4.2", deadlineMs: 2000 });
      expect(selected?.path).toBe(realpathSync.native(join(last, name)));
      expect(selected?.version).toMatch(/^1\.(?:[4-9]|[1-9]\d+)\./);
    } finally { removeTree(root); }
  });
});

function launcherFallbackFixture(mode: "missing" | "bundled" | "repair" | "broken" | "override" | "none" | "inspection" | "rejected") {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-path-launcher-")));
  try {
    const node = spawnSync("node", ["-p", "process.execPath"], { encoding: "utf8", windowsHide: true }).stdout.trim();
    const version = spawnSync(process.execPath, ["--version"], { encoding: "utf8", windowsHide: true }).stdout.trim();
    expect(version).toMatch(/^1\.(?:[4-9]|[1-9]\d+)\./);
    cpSync(repoPath("src"), join(root, "src"), { recursive: true });
    mkdirSync(join(root, "bin"));
    copyFileSync(BIN_OCX, join(root, "bin", "ocx.mjs"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: "2.81.0", dependencies: { bun: "1.4.2" } }));
    writeFileSync(join(root, "src", "cli", "index.ts"), 'console.log(JSON.stringify({source:process.env.OCX_BUN_RUNTIME_SOURCE,path:process.env.OCX_BUN_RUNTIME_PATH}));');
    const pathDir = join(root, "path"); mkdirSync(pathDir);
    const pathBun = join(pathDir, process.platform === "win32" ? "bun.exe" : "bun");
    if (mode === "rejected") {
      writeFileSync(pathBun, '#!/bin/sh\nprintf "2.0.0\\n"\n#' + "x".repeat(REAL_BUN_MIN_BYTES));
      chmodSync(pathBun, 0o755);
    } else if (mode !== "none") { copyFileSync(process.execPath, pathBun); chmodSync(pathBun, 0o755); }
    const bundleDir = join(root, "node_modules", "bun");
    if (["bundled", "repair", "broken", "inspection"].includes(mode)) {
      mkdirSync(join(bundleDir, "bin"), { recursive: true });
      writeFileSync(join(bundleDir, "package.json"), '{"name":"bun","version":"1.4.2"}');
      const bundle = join(bundleDir, "bin", "bun.exe");
      if (mode === "bundled") { copyFileSync(process.execPath, bundle); chmodSync(bundle, 0o755); }
      else writeFileSync(bundle, "stub");
      const installer = mode === "repair"
        ? `const fs=require("node:fs");fs.copyFileSync(${JSON.stringify(process.execPath)},${JSON.stringify(bundle)});fs.chmodSync(${JSON.stringify(bundle)},0o755);`
        : 'process.exit(1);';
      writeFileSync(join(bundleDir, "install.js"), `require("node:fs").writeFileSync(${JSON.stringify(join(root, "installer-ran"))},"yes");` + installer);
    }
    const env = isolatedLauncherEnv(root, mode === "override" ? pathBun : "");
    env.PATH = pathDir;
    for (const key of Object.keys(env)) if (key.toLowerCase() === "path" && key !== "PATH") delete env[key];
    const args = mode === "inspection" ? ["system", "codex-cli-update", "inspect", "--json"] : ["--version"];
    const result = spawnSync(node, [join(root, "bin", "ocx.mjs"), ...args], { cwd: root, env, encoding: "utf8", timeout: 30_000, windowsHide: true });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr,
      installerRan: existsSync(join(root, "installer-ran")),
      version, pathBun, canonicalPathBun: mode === "none" ? null : realpathSync.native(pathBun),
      bundle: join(bundleDir, "bin", "bun.exe") };
  } finally { removeTree(root); }
}

describe.skipIf(!nodeAvailable)("Node launcher PATH fallback activation", () => {
  test.each(["missing", "broken", "inspection"] as const)("%s bundle reaches validated PATH Bun", mode => {
    const result = launcherFallbackFixture(mode);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ source: "process", path: result.canonicalPathBun });
    expect(result.stderr).toBe(`opencodex: using PATH Bun ${result.version}.\n`);
    expect(result.installerRan).toBe(mode === "broken");
  });
  test.each(["bundled", "repair", "override"] as const)("%s runtime wins over PATH", mode => {
    const result = launcherFallbackFixture(mode);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ source: mode === "override" ? "override" : "bundled", path: mode === "override" ? result.pathBun : result.bundle });
    expect(result.stderr).not.toContain("using PATH Bun");
    expect(result.installerRan).toBe(mode === "repair");
  });
  test("terminal missing-bundle error is reached only when PATH has no usable Bun", () => {
    const result = launcherFallbackFixture("none");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("the `bun` dependency is not installed");
    expect(result.stderr).not.toContain("using PATH Bun");
  });
});

describe.skipIf(!nodeAvailable)("PATH fallback negative activation", () => {
  test.skipIf(process.platform === "win32")("rejected PATH versions never expose candidate paths", () => {
    const result = launcherFallbackFixture("rejected");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the `bun` dependency is not installed");
    expect(result.stderr).not.toContain(result.pathBun);
    expect(result.stderr).not.toContain("using PATH Bun");
  });
  test.skipIf(process.platform === "win32")("real version probe returns null within the deadline", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-path-timeout-"));
    try {
      const path = join(root, "bun");
      writeFileSync(path, '#!/bin/sh\nexec /bin/sleep 5\n#' + "x".repeat(REAL_BUN_MIN_BYTES));
      chmodSync(path, 0o755);
      const started = performance.now();
      expect(findPathBun({ env: { PATH: root }, pinnedVersion: "1.4.2", deadlineMs: 50 })).toBeNull();
      expect(performance.now() - started).toBeLessThan(1500);
    } finally { removeTree(root); }
  });
});

describe.skipIf(!nodeAvailable)("Node-safe Desktop supervision update guard", () => {
  test("the real Node launcher loads update --help without package-manager probes", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-node-update-help-"));
    try {
      const result = spawnSync("node", [BIN_OCX, "update", "--help"], {
        encoding: "utf8", timeout: 10_000, windowsHide: true,
        env: isolatedLauncherEnv(root, ""),
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("update");
      expect(result.stderr).toBe("");
    } finally { removeTree(root); }
  });

  test("node -e imports the latch and inspector with injected darwin/Linux identities", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-node-supervision-"));
    try {
      const macos = join(root, "OpenCodex.app", "Contents", "MacOS");
      mkdirSync(macos, { recursive: true });
      const app = join(macos, "opencodex-desktop"), proxy = join(macos, "ocx");
      for (const file of [app, proxy]) { writeFileSync(file, "fixture"); chmodSync(file, 0o755); }
      const moduleUrl = pathToFileURL(repoPath("src/service/desktop-supervision.mjs")).href;
      const script = `
        const { inspectDesktopSupervision, createSupervisionLatch } = await import(${JSON.stringify(moduleUrl)});
        const app = ${JSON.stringify(app)}, proxy = ${JSON.stringify(proxy)};
        const states = ["linux", "darwin"].map(platform => inspectDesktopSupervision({
          platform, readPid: () => 321, readRuntimePortPid: () => 321,
          proc: { exe: pid => pid === 321 ? proxy : app, parent: pid => pid === 321 ? 123 : 1 },
          run: (_command, args) => args[1] === "321" ? "123 " + proxy : "1 " + app,
        }));
        const latch = createSupervisionLatch();
        const sequence = [states[0], { kind: "unknown", reason: "probe-failed", desktopSeen: false },
          { kind: "unsupported" }, { kind: "none" }].map(evidence => latch.observe(evidence));
        const uncertain = createSupervisionLatch();
        const unknownSequence = [{ kind: "unknown", reason: "probe-failed", desktopSeen: true },
          { kind: "unknown", reason: "probe-failed", desktopSeen: false }, { kind: "none" }]
          .map(evidence => uncertain.observe(evidence));
        const mismatch = inspectDesktopSupervision({ platform: "linux", targetPid: 999,
          readPid: () => 321, readRuntimePortPid: () => 321 });
        const none = inspectDesktopSupervision({ platform: "linux", readPid: () => null, readRuntimePortPid: () => null });
        process.stdout.write(JSON.stringify({ kinds: states.map(state => state.kind), sequence, unknownSequence, mismatch, none }));
      `;
      const result = spawnSync("node", ["--input-type=module", "-e", script], {
        encoding: "utf8", timeout: 10_000, windowsHide: true, env: isolatedLauncherEnv(root, ""),
      });
      expect(result.status).toBe(0); expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        kinds: ["desktop", "desktop"], sequence: [true, true, true, false], unknownSequence: [true, true, false],
        mismatch: { kind: "unknown", reason: "pid-mismatch", desktopSeen: false }, none: { kind: "none" },
      });
    } finally { removeTree(root); }
  });
});
