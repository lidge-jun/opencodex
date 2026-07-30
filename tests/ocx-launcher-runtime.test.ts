import { describe, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bundledBunPath } from "../src/lib/bun-runtime";
import { killProxy } from "../src/lib/process-control";

const BIN_OCX = join(import.meta.dir, "..", "bin", "ocx.mjs");
const nodeAvailable = spawnSync("node", ["--version"], {
  stdio: "ignore",
  windowsHide: true,
}).status === 0;
const runnable = process.platform === "win32" && nodeAvailable;

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
  const opencodexHome = join(root, "opencodex");
  const codexHome = join(root, "codex");
  const grokHome = join(root, "grok");
  mkdirSync(opencodexHome, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(grokHome, { recursive: true });

  const port = await freePort();
  let launcher: ChildProcess | null = null;
  let ownedLauncher: WindowsProcessIdentity | null = null;
  let ownedProxy: WindowsProcessIdentity | null = null;
  try {
    launcher = spawn("node", [BIN_OCX, "start", "--port", String(port)], {
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        OPENCODEX_HOME: opencodexHome,
        CODEX_HOME: codexHome,
        GROK_HOME: grokHome,
        OPENCODEX_BUN_PATH: override,
      },
    });
    if (!launcher.pid) throw new Error("Node launcher has no process id");
    ownedLauncher = windowsProcessIdentity(launcher.pid);
    if (!ownedLauncher) throw new Error("could not capture Node launcher process identity");

    const health = await waitForHealth(port, 25_000, launcher);
    if (!health) throw new Error("proxy did not become healthy");
    const identity = windowsProcessIdentity(health.pid);
    if (!identity || identity.parentPid !== launcher.pid) {
      throw new Error("health PID is not the spawned Node launcher's direct Bun child");
    }
    ownedProxy = identity;
    return identity.executablePath;
  } finally {
    // Both identities were captured from processes this test spawned. Re-query
    // before each kill so a reused PID can never become a cleanup target.
    const cleanupErrors: string[] = [];
    for (const [label, identity] of [
      ["launcher", ownedLauncher],
      ["proxy", ownedProxy],
    ] as const) {
      if (!identity || !sameProcess(windowsProcessIdentity(identity.pid), identity)) continue;
      try {
        killProxy(identity.pid);
      } catch (error) {
        cleanupErrors.push(`${label} cleanup failed: ${String(error)}`);
      }
      if (sameProcess(windowsProcessIdentity(identity.pid), identity)) {
        cleanupErrors.push(`owned ${label} PID ${identity.pid} remained after bounded cleanup`);
      }
    }
    try {
      removeTree(root);
    } catch (error) {
      cleanupErrors.push(`fixture cleanup failed: ${String(error)}`);
    }
    if (cleanupErrors.length > 0) throw new Error(cleanupErrors.join("; "));
  }
}

describe.skipIf(!runnable)("ocx npm launcher effective Bun runtime", () => {
  test("uses a valid OPENCODEX_BUN_PATH for the actual proxy process", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-launcher-runtime-copy-"));
    try {
      const override = join(root, "override-bun.exe");
      copyFileSync(process.execPath, override);
      expect(sameWindowsPath(await effectiveRuntime(override), override)).toBe(true);
    } finally {
      removeTree(root);
    }
  }, 120_000);

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
  }, 120_000);
});
