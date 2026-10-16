import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, win32 } from "node:path";

// Node >=18 also imports this module from bin/ocx.mjs; do not import TS or Bun APIs.
function run(command, args, timeout = 750) {
  return execFileSync(command, args, {
    encoding: "utf8", timeout, maxBuffer: 128 * 1024, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  }).trim();
}

// Mirror src/config/paths.ts getConfigDir/expandUserPath and process-state.ts paths.
// Keep this Node-safe copy in sync; the focused startup test pins both implementations.
export function desktopSupervisionPaths() {
  const raw = process.env.OPENCODEX_HOME?.trim();
  const expanded = raw === "~" ? homedir()
    : raw?.startsWith("~/") || raw?.startsWith("~\\") ? join(homedir(), raw.slice(2)) : raw;
  const home = expanded ? resolve(expanded) : join(homedir(), ".opencodex");
  return { pid: join(home, "ocx.pid"), runtimePort: join(home, "runtime-port.json") };
}

function validPid(pid) {
  return Number.isSafeInteger(pid) && pid > 0;
}

function readState(path, parse) {
  try { return parse(readFileSync(path, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function readPidFile() {
  return readState(desktopSupervisionPaths().pid, raw => {
    const text = raw.trim();
    if (!/^\d+$/.test(text) || !validPid(Number(text))) throw new Error("invalid pid");
    return Number(text);
  });
}

function readRuntimePortPid() {
  return readState(desktopSupervisionPaths().runtimePort, raw => {
    // Only project pid: no credential validation, serialization or returned port state.
    const pid = JSON.parse(raw)?.pid;
    if (!validPid(pid)) throw new Error("invalid runtime pid");
    return pid;
  });
}

/** Linux identity fields count from the end of comm, which may contain spaces or ')'. */
export const procfs = {
  exe: pid => readlinkSync(`/proc/${pid}/exe`),
  parent: pid => {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  },
};

export function processIdentity(pid, execute = run, onExecutable) {
  const text = execute("/bin/ps", ["-p", String(pid), "-o", "ppid=,comm="]).trim();
  const row = /^(\d+)\s+(.+)$/.exec(text);
  if (!row) {
    if (text) throw new Error("invalid process identity");
    return null;
  }
  onExecutable?.(row[2]);
  return { parent: Number(row[1]), executable: realpathSync(row[2]) };
}

/**
 * Windows has no ps or procfs that Node can read, so one bounded Win32_Process read
 * answers the runtime row and its parent's row. Each inspection shares one budget
 * across its two snapshots; the startup diagnostic runs two inspections, and both
 * must fit the 15 s Windows startup probe (src/codex/autostart-health.ts).
 */
const WINDOWS_INSPECTION_BUDGET_MS = 6_000;
const WINDOWS_ACQUISITION_TIMEOUT_MS = 3_000;
const WINDOWS_MIN_ACQUISITION_MS = 250;
const WINDOWS_DESKTOP_IMAGE = "opencodex-desktop.exe";

/** Mirrors src/update/npm-invocation.mjs: plain ESM cannot reach the FFI system-directory resolver. */
export function windowsPowerShellPath(env = process.env) {
  const root = env.SystemRoot ?? env.windir;
  const base = root && /^[A-Za-z]:\\/.test(root.replaceAll("/", "\\")) ? root : "C:\\Windows";
  return win32.join(base, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function windowsProcessScript(pid) {
  // pid is a validated safe integer; it only ever reaches a numeric WQL filter.
  return [
    "$ErrorActionPreference='Stop'",
    "function Row($p) { if ($null -eq $p) { return $null }; [ordered]@{ pid=[string]$p.ProcessId; parent=[string]$p.ParentProcessId; exe=$p.ExecutablePath; session=[string]$p.SessionId; created=$(if ($p.CreationDate) { [string]$p.CreationDate.ToUniversalTime().Ticks } else { $null }) } }",
    `$c=Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${pid}'`,
    "$p=$null",
    "if ($c -and [uint32]$c.ParentProcessId -gt 0) { $p=Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId=' + [uint32]$c.ParentProcessId) }",
    "[ordered]@{ child=(Row $c); parent=(Row $p) } | ConvertTo-Json -Compress",
  ].join("; ");
}

function windowsInteger(value) {
  const text = typeof value === "number" || typeof value === "string" ? String(value) : "";
  if (!/^\d{1,10}$/.test(text)) throw new Error("invalid process field");
  return Number(text);
}

function windowsRow(row) {
  if (row === null || row === undefined) return null;
  if (typeof row !== "object" || Array.isArray(row)) throw new Error("invalid process row");
  // Ticks exceed 2^53; they stay decimal strings and are compared as BigInt.
  if (typeof row.created !== "string" || !/^\d{1,20}$/.test(row.created)) throw new Error("invalid creation time");
  if (row.exe !== null && row.exe !== undefined && typeof row.exe !== "string") throw new Error("invalid image");
  return {
    pid: windowsInteger(row.pid), parent: windowsInteger(row.parent), exe: row.exe ?? null,
    session: windowsInteger(row.session), created: row.created,
  };
}

/** One bounded Win32_Process read of a process and its parent. */
export function windowsProcessPair(pid, execute = run, options = {}) {
  if (!validPid(pid)) throw new Error("invalid pid");
  const output = execute(windowsPowerShellPath(options.env), [
    "-NoProfile", "-NoLogo", "-NonInteractive", "-Command", windowsProcessScript(pid),
  ], options.timeoutMs ?? WINDOWS_ACQUISITION_TIMEOUT_MS);
  const raw = JSON.parse(output);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid process pair");
  // A Desktop parent seen before a later field fails validation must keep its veto.
  if (raw.parent && typeof raw.parent === "object" && typeof raw.parent.exe === "string") options.onExecutable?.(raw.parent.exe);
  return { child: windowsRow(raw.child), parent: windowsRow(raw.parent) };
}

/** Only a drive-absolute image proves an install directory; UNC, device and relative forms do not. */
function windowsImage(path) {
  if (typeof path !== "string") return null;
  const text = path.replaceAll("/", "\\");
  return /^[A-Za-z]:\\[^\\]/.test(text) ? win32.normalize(text) : null;
}

/** Live supervision is evidence, never a durable ownership claim. */
export function inspectDesktopSupervision(deps = {}) {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") return { kind: "unsupported" };
  let desktopSeen = false;
  const unknown = reason => ({ kind: "unknown", reason, desktopSeen });
  const seen = executable => {
    const name = platform === "win32" ? win32.basename(executable).toLowerCase() : basename(executable);
    if (name === (platform === "win32" ? WINDOWS_DESKTOP_IMAGE : "opencodex-desktop")) desktopSeen = true;
  };
  const readPid = deps.readPid ?? readPidFile;
  const readPortPid = deps.readRuntimePortPid ?? readRuntimePortPid;
  const proc = deps.proc ?? procfs;
  const execute = deps.run ?? run;
  const now = deps.now ?? Date.now;
  const deadline = now() + WINDOWS_INSPECTION_BUDGET_MS;
  const readWindowsPair = deps.windowsProcesses
    ?? ((pid, options) => windowsProcessPair(pid, execute, { ...options, env: deps.env }));
  function identity(pid, parent = false) {
    if (platform === "darwin") return processIdentity(pid, execute, parent ? seen : undefined);
    const executable = proc.exe(pid);
    if (parent) seen(executable);
    const parentPid = proc.parent(pid);
    if (!Number.isSafeInteger(parentPid) || parentPid < 0) throw new Error("invalid parent pid");
    return { parent: parentPid, executable: realpathSync(executable) };
  }
  function windowsCapture(pidFile, portPid, runtimePid) {
    // Windows has no reaped-parent signal to fall back on, so both runtime records must agree.
    if (pidFile === null || portPid === null) return { error: "pid-record-missing" };
    const remaining = deadline - now();
    if (remaining < WINDOWS_MIN_ACQUISITION_MS) return { error: "probe-timeout" };
    const pair = readWindowsPair(runtimePid, {
      onExecutable: seen, timeoutMs: Math.min(WINDOWS_ACQUISITION_TIMEOUT_MS, remaining),
    });
    const child = pair?.child ?? null;
    const parent = pair?.parent ?? null;
    if (!child) return { error: "process-missing" };
    if (child.pid !== runtimePid) return { error: "probe-failed" };
    if (!parent) return { error: "parent-missing" };
    if (parent.pid !== child.parent) return { error: "probe-failed" };
    const app = windowsImage(parent.exe);
    const proxy = windowsImage(child.exe);
    if (!app || !proxy) return { error: "image-unqualified" };
    const snapshot = { pidFile, portPid, runtimePid, child, parent };
    // A reused parent PID belongs to a process created after the runtime it claims to supervise;
    // its image proves nothing about the real parent, so it cannot answer "none" either.
    if (BigInt(parent.created) >= BigInt(child.created)) return { error: "creation-order" };
    if (win32.basename(app).toLowerCase() !== WINDOWS_DESKTOP_IMAGE) return { ...snapshot, kind: "none" };
    seen(app);
    if (proxy.toLowerCase() !== win32.join(win32.dirname(app), "ocx.exe").toLowerCase()) return { error: "proxy-mismatch" };
    if (child.session !== parent.session) return { error: "session-mismatch" };
    return { ...snapshot, kind: "desktop", app, proxy };
  }
  function capture() {
    const pidFile = readPid();
    const portPid = readPortPid();
    const pids = [deps.targetPid, pidFile, portPid].filter(pid => pid !== undefined && pid !== null);
    if (pids.some(pid => !validPid(pid))) return { error: "invalid-pid" };
    if (pids.some(pid => pid !== pids[0])) return { error: "pid-mismatch" };
    const runtimePid = pids[0] ?? null;
    if (platform === "win32") {
      // Missing records are never positive absence on Windows: they could clear a Desktop veto.
      return runtimePid === null ? { error: "pid-record-missing" } : windowsCapture(pidFile, portPid, runtimePid);
    }
    const child = runtimePid !== null ? identity(runtimePid) : null;
    const parent = child && child.parent > 1 ? identity(child.parent, true) : null;
    const snapshot = { pidFile, portPid, runtimePid, child, parent };
    if (!runtimePid || !child || !parent || basename(parent.executable) !== "opencodex-desktop") {
      return { ...snapshot, kind: "none" };
    }
    seen(parent.executable);
    const app = parent.executable;
    if (platform === "darwin" && (basename(dirname(app)) !== "MacOS"
      || basename(dirname(dirname(app))) !== "Contents")) return { error: "app-mismatch" };
    const proxy = realpathSync(join(dirname(app), "ocx"));
    if (child.executable !== proxy || (platform === "linux"
      && (dirname(proxy) !== dirname(app) || basename(proxy) !== "ocx"))) return { error: "proxy-mismatch" };
    accessSync(app, constants.X_OK);
    accessSync(proxy, constants.X_OK);
    return { ...snapshot, kind: "desktop", app, proxy };
  }
  try {
    const first = capture();
    if (first.error) return unknown(first.error);
    const final = capture();
    if (final.error) return unknown(final.error);
    if (JSON.stringify(first) !== JSON.stringify(final)) return unknown("snapshot-changed");
    return final.kind === "desktop"
      ? { kind: "desktop", runtimePid: final.runtimePid, supervisorPid: final.child.parent, app: final.app, proxy: final.proxy }
      : { kind: "none" };
  } catch {
    // Error messages can contain paths or file contents; expose only the bounded reason.
    return unknown("probe-failed");
  }
}

/** One operation retains its Desktop veto through inconclusive later probes. */
export function createSupervisionLatch() {
  let blocked = false;
  return {
    observe(evidence) {
      if (evidence.kind === "none") blocked = false;
      else if (evidence.kind === "desktop" || (evidence.kind === "unknown" && evidence.desktopSeen)) blocked = true;
      return blocked;
    },
  };
}
