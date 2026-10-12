#!/usr/bin/env bun
/**
 * Hosted Linux packaged-shell acceptance.
 *
 * This is deliberately narrower than installed-gate.ts. It extracts, rather than
 * installs, the AppImage and deb payloads so a hosted runner never mutates its package
 * database or the runner account's real OpenCodex home. What it proves is the common
 * packaged path: the real application executable and bundled resources can show a
 * window in a session with no tray host, start their bundled sidecar, identify that
 * runtime, and drain both processes when the only window closes.
 *
 * Real dpkg/AppImage installation, elevation, takeover, and in-place updates remain the
 * responsibility of installed-gate.ts on an approved disposable GUI runner.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createServer } from "node:net";

export type LinuxBundleFormat = "appimage" | "deb";

export interface LinuxE2eOptions {
  bundleRoot: string;
  reportPath: string;
  version: string;
}

export interface BundleArtifacts {
  appimage: string;
  deb: string;
}

interface RuntimeRecord {
  pid: number;
  port: number;
}

interface HealthObservation {
  status: number;
  body: Record<string, unknown>;
}

interface ReservedLoopbackPort {
  port: number;
  release: () => Promise<void>;
}

interface FormatReport {
  format: LinuxBundleFormat;
  artifact: string;
  ok: boolean;
  durationMs: number;
  windowId?: string;
  appPid?: number;
  appExitCode?: number | null;
  appExitSignal?: string | null;
  runtimePid?: number;
  runtimeVersion?: string;
  configuredPort?: number;
  readyMs?: number;
  processTreeRssKiB?: number;
  error?: string;
  stdoutTail?: string[];
  stderrTail?: string[];
}

interface AcceptanceReport {
  schema: "opencodex-linux-packaged-e2e/1";
  version: string;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  formats: FormatReport[];
}

const READY_DEADLINE_MS = 45_000;
const EXIT_DEADLINE_MS = 30_000;
const POLL_MS = 200;
const LOG_TAIL_LINES = 80;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function argument(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function parseArguments(argv: string[]): LinuxE2eOptions {
  const bundleRoot = argument(argv, "--bundle-root");
  const reportPath = argument(argv, "--report");
  const version = argument(argv, "--version");
  if (!bundleRoot || !reportPath || !version) {
    throw new Error("--bundle-root, --report and --version are required");
  }
  if (!VERSION.test(version)) throw new Error("--version must be a strict semver");
  return {
    bundleRoot: resolve(bundleRoot),
    reportPath: resolve(reportPath),
    version,
  };
}

function files(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .map(name => join(directory, name))
    .filter(path => statSync(path).isFile());
}

function exactlyOne(paths: string[], label: string): string {
  if (paths.length !== 1) {
    throw new Error(`expected exactly one ${label}, found ${paths.length}`);
  }
  return paths[0]!;
}

export function locateArtifacts(bundleRoot: string): BundleArtifacts {
  return {
    appimage: exactlyOne(
      files(join(bundleRoot, "appimage")).filter(path => path.endsWith(".AppImage")),
      "AppImage",
    ),
    deb: exactlyOne(
      files(join(bundleRoot, "deb")).filter(path => path.endsWith(".deb")),
      "deb",
    ),
  };
}

function command(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): void {
  const result = spawnSync(file, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "no output").trim();
    throw new Error(`${basename(file)} exited ${result.status ?? "without a status"}: ${detail}`);
  }
}

function executableFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .map(name => join(directory, name))
    .filter(path => {
      const stat = statSync(path);
      return stat.isFile() && (stat.mode & 0o111) !== 0;
    });
}

export function extractedExecutable(
  format: LinuxBundleFormat,
  artifact: string,
  destination: string,
): string {
  mkdirSync(destination, { recursive: true });
  if (format === "appimage") {
    command(artifact, ["--appimage-extract"], { cwd: destination });
    const appRun = join(destination, "squashfs-root", "AppRun");
    if (!existsSync(appRun)) throw new Error("AppImage extraction did not produce AppRun");
    return appRun;
  }

  command("dpkg-deb", ["--extract", artifact, destination]);
  const candidates = executableFiles(join(destination, "usr", "bin"));
  return selectDebExecutable(candidates);
}

export function selectDebExecutable(candidates: string[]): string {
  // The package contains the desktop host and its `ocx` sidecar. The sidecar is deliberately
  // executable, but it is not the process whose WebView/window lifecycle this acceptance owns.
  return exactlyOne(
    candidates.filter(candidate => basename(candidate) !== "ocx"),
    "deb desktop executable under usr/bin",
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function reserveLoopbackPort(): Promise<ReservedLoopbackPort> {
  return await new Promise<ReservedLoopbackPort>((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("could not reserve a temporary loopback port"));
        return;
      }
      let released = false;
      resolvePort({
        port: address.port,
        release: async () => {
          if (released) return;
          released = true;
          await new Promise<void>((resolveClose, rejectClose) => {
            server.close(error => error ? rejectClose(error) : resolveClose());
          });
        },
      });
    });
  });
}

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await sleep(POLL_MS);
  }
  throw new Error(`condition did not settle within ${timeoutMs}ms`);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function readRuntimeRecord(path: string): RuntimeRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const pid = positiveInteger(parsed.pid);
    const port = positiveInteger(parsed.port);
    if (pid === undefined || port === undefined || port > 65_535) return undefined;
    return { pid, port };
  } catch {
    return undefined;
  }
}

export function assertRuntimeRecordPort(record: RuntimeRecord, configuredPort: number): RuntimeRecord {
  if (record.port !== configuredPort) {
    throw new Error(
      `packaged runtime recorded port ${record.port}, expected isolated port ${configuredPort}`,
    );
  }
  return record;
}

function processAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

function processRows(): Array<{ pid: number; ppid: number; rssKiB: number }> {
  const result = spawnSync("ps", ["-e", "-o", "pid=,ppid=,rss="], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout
    .trim()
    .split(/\r?\n/u)
    .map(line => line.trim().split(/\s+/u).map(Number))
    .filter(parts => parts.length === 3 && parts.every(Number.isFinite))
    .map(parts => ({ pid: parts[0]!, ppid: parts[1]!, rssKiB: parts[2]! }));
}

export interface AppExit {
  code: number | null;
  signal: string | null;
}

/**
 * The close request goes through the window manager (EWMH _NET_CLOSE_WINDOW), the same path a
 * person's close button takes. xdotool's windowclose destroys the X window instead, which can end
 * the process without ever running Tauri's close/drain handling and still look like a clean exit.
 */
export function windowManagerCloseArgs(windowId: string): string[] {
  const id = Number(windowId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`invalid X11 window id: ${windowId}`);
  return ["-i", "-c", `0x${id.toString(16)}`];
}

/** A graceful close exits 0 on its own; a signal or a nonzero code is a crash, not a drain. */
export function assertCleanExit(exit: AppExit | undefined): AppExit {
  if (!exit) throw new Error("desktop app did not exit after the close request");
  if (exit.signal !== null || exit.code !== 0) {
    throw new Error(`desktop app exited with code ${exit.code ?? "none"} and signal ${exit.signal ?? "none"} instead of a clean close`);
  }
  return exit;
}

export function processTreeRssKiB(rootPid: number, rows = processRows()): number {
  const selected = new Set<number>([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (selected.has(row.ppid) && !selected.has(row.pid)) {
        selected.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter(row => selected.has(row.pid)).reduce((sum, row) => sum + row.rssKiB, 0);
}

function xdotoolWindow(): string | undefined {
  // WebKit exposes an auxiliary `opencodex-desktop` X11 window before the titled top-level
  // `OpenCodex` window. A loose match selected that helper and `windowclose` merely destroyed the
  // web process surface, never exercising Tauri's close/drain path.
  const result = spawnSync(
    "xdotool",
    ["search", "--onlyvisible", "--name", "^OpenCodex$"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return undefined;
  return result.stdout.trim().split(/\r?\n/u).find(Boolean);
}

async function health(record: RuntimeRecord): Promise<HealthObservation | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${record.port}/healthz`, {
      signal: AbortSignal.timeout(1_000),
      cache: "no-store",
    });
    const body = await response.json();
    return typeof body === "object" && body !== null
      ? { status: response.status, body: body as Record<string, unknown> }
      : undefined;
  } catch {
    return undefined;
  }
}

function tail(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split(/\r?\n/u).filter(Boolean).slice(-LOG_TAIL_LINES);
  } catch {
    return [];
  }
}

async function stopGroup(child: ChildProcess): Promise<void> {
  if (!child.pid || !processAlive(child.pid)) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  try {
    await waitFor(() => processAlive(child.pid) ? undefined : true, 5_000);
    return;
  } catch {
    // Escalate only inside the detached process group this test created.
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

async function runFormat(
  format: LinuxBundleFormat,
  artifact: string,
  version: string,
  root: string,
): Promise<FormatReport> {
  const started = Date.now();
  const directory = join(root, format);
  const extracted = join(directory, "payload");
  const home = join(directory, "home");
  const opencodexHome = join(home, ".opencodex");
  const codexHome = join(home, ".codex");
  const configHome = join(home, ".config");
  const cacheHome = join(home, ".cache");
  const dataHome = join(home, ".local", "share");
  for (const path of [home, opencodexHome, codexHome, configHome, cacheHome, dataHome]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const stdoutPath = join(directory, "stdout.log");
  const stderrPath = join(directory, "stderr.log");
  mkdirSync(directory, { recursive: true });
  const stdout = openSync(stdoutPath, "w", 0o600);
  const stderr = openSync(stderrPath, "w", 0o600);
  let child: ChildProcess | undefined;
  let runtimePid: number | undefined;
  let configuredPort: number | undefined;
  let reservedPort: ReservedLoopbackPort | undefined;
  try {
    const executable = extractedExecutable(format, artifact, extracted);
    reservedPort = await reserveLoopbackPort();
    configuredPort = reservedPort.port;
    writeFileSync(
      join(opencodexHome, "config.json"),
      `${JSON.stringify({ port: configuredPort }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: configHome,
      XDG_CACHE_HOME: cacheHome,
      XDG_DATA_HOME: dataHome,
      OPENCODEX_HOME: opencodexHome,
      CODEX_HOME: codexHome,
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
      WEBKIT_DISABLE_COMPOSITING_MODE: "1",
    };
    // Hold the listener while preparing the isolated home so no unrelated process can claim the
    // selected port. Release it only at the spawn boundary; the packaged runtime can then bind it.
    await reservedPort.release();
    reservedPort = undefined;
    child = spawn(executable, [], {
      cwd: dirname(executable),
      env,
      detached: true,
      stdio: ["ignore", stdout, stderr],
    });
    if (!child.pid) throw new Error("desktop app did not report a pid");
    const appPid = child.pid;
    let appExit: AppExit | undefined;
    child.once("exit", (code, signal) => {
      appExit = { code, signal };
    });
    const windowId = await waitFor(xdotoolWindow, READY_DEADLINE_MS);
    const recordPath = join(opencodexHome, "runtime-port.json");
    const record = assertRuntimeRecordPort(
      await waitFor(() => readRuntimeRecord(recordPath), READY_DEADLINE_MS),
      configuredPort,
    );
    runtimePid = record.pid;
    let lastHealth: HealthObservation | undefined;
    let ready: Record<string, unknown>;
    try {
      ready = await waitFor(async () => {
        const observed = await health(record);
        if (!observed) return undefined;
        lastHealth = observed;
        const body = observed.body;
        return observed.status >= 200 && observed.status < 300
          && body.service === "opencodex"
          && body.pid === record.pid
          && body.port === record.port
          && body.version === version
          ? body
          : undefined;
      }, READY_DEADLINE_MS);
    } catch {
      const observed = lastHealth
        ? `status ${lastHealth.status}, body ${JSON.stringify(lastHealth.body)}`
        : "no readable /healthz response";
      throw new Error(`packaged runtime health identity did not become ready (${observed})`);
    }
    const readyMs = Date.now() - started;
    const rssKiB = processTreeRssKiB(appPid);

    command("wmctrl", windowManagerCloseArgs(windowId));
    await waitFor(
      () => appExit && !processAlive(runtimePid) ? true : undefined,
      EXIT_DEADLINE_MS,
    );
    const exit = assertCleanExit(appExit);
    return {
      format,
      artifact: basename(artifact),
      ok: true,
      durationMs: Date.now() - started,
      windowId,
      appPid,
      appExitCode: exit.code,
      appExitSignal: exit.signal,
      runtimePid,
      runtimeVersion: typeof ready.version === "string" ? ready.version : undefined,
      configuredPort,
      readyMs,
      processTreeRssKiB: rssKiB,
      stdoutTail: tail(stdoutPath),
      stderrTail: tail(stderrPath),
    };
  } catch (error) {
    return {
      format,
      artifact: basename(artifact),
      ok: false,
      durationMs: Date.now() - started,
      ...(child?.pid ? { appPid: child.pid } : {}),
      ...(runtimePid ? { runtimePid } : {}),
      ...(configuredPort ? { configuredPort } : {}),
      error: error instanceof Error ? error.message : String(error),
      stdoutTail: tail(stdoutPath),
      stderrTail: tail(stderrPath),
    };
  } finally {
    await reservedPort?.release();
    if (child) await stopGroup(child);
    closeSync(stdout);
    closeSync(stderr);
  }
}

export async function runAcceptance(options: LinuxE2eOptions): Promise<AcceptanceReport> {
  if (process.platform !== "linux") throw new Error("Linux packaged E2E runs only on Linux");
  for (const dependency of ["dpkg-deb", "ps", "wmctrl", "xdotool"]) {
    const probe = spawnSync("sh", ["-c", `command -v ${dependency}`]);
    if (probe.status !== 0) throw new Error(`missing required command: ${dependency}`);
  }
  if (!process.env.DISPLAY) throw new Error("DISPLAY is required; run under Xvfb");

  const artifacts = locateArtifacts(options.bundleRoot);
  const root = mkdtempSync(join(tmpdir(), "opencodex-linux-e2e-"));
  const startedAt = new Date().toISOString();
  let formats: FormatReport[] = [];
  try {
    formats = [
      await runFormat("appimage", artifacts.appimage, options.version, root),
      await runFormat("deb", artifacts.deb, options.version, root),
    ];
  } finally {
    const report: AcceptanceReport = {
      schema: "opencodex-linux-packaged-e2e/1",
      version: options.version,
      startedAt,
      finishedAt: new Date().toISOString(),
      ok: formats.length === 2 && formats.every(format => format.ok),
      formats,
    };
    mkdirSync(dirname(options.reportPath), { recursive: true });
    writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    rmSync(root, { recursive: true, force: true });
  }
  return JSON.parse(readFileSync(options.reportPath, "utf8")) as AcceptanceReport;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const report = await runAcceptance(options);
  for (const format of report.formats) {
    console.log(`${format.ok ? "PASS" : "FAIL"} ${format.format}: ${format.error ?? `${format.readyMs}ms ready, ${format.processTreeRssKiB} KiB RSS`}`);
  }
  process.exitCode = report.ok ? 0 : 1;
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
