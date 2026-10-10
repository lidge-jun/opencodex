import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// Node >=18 also imports this module from bin/ocx.mjs; do not import TS or Bun APIs.
function run(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8", timeout: 750, maxBuffer: 128 * 1024, stdio: ["ignore", "pipe", "pipe"],
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

/** Live supervision is evidence, never a durable ownership claim. */
export function inspectDesktopSupervision(deps = {}) {
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") return { kind: "unsupported" };
  let desktopSeen = false;
  const unknown = reason => ({ kind: "unknown", reason, desktopSeen });
  const seen = executable => { if (basename(executable) === "opencodex-desktop") desktopSeen = true; };
  const readPid = deps.readPid ?? readPidFile;
  const readPortPid = deps.readRuntimePortPid ?? readRuntimePortPid;
  const proc = deps.proc ?? procfs;
  const execute = deps.run ?? run;
  function identity(pid, parent = false) {
    if (platform === "darwin") return processIdentity(pid, execute, parent ? seen : undefined);
    const executable = proc.exe(pid);
    if (parent) seen(executable);
    const parentPid = proc.parent(pid);
    if (!Number.isSafeInteger(parentPid) || parentPid < 0) throw new Error("invalid parent pid");
    return { parent: parentPid, executable: realpathSync(executable) };
  }
  function capture() {
    const pidFile = readPid();
    const portPid = readPortPid();
    const pids = [deps.targetPid, pidFile, portPid].filter(pid => pid !== undefined && pid !== null);
    if (pids.some(pid => !validPid(pid))) return { error: "invalid-pid" };
    if (pids.some(pid => pid !== pids[0])) return { error: "pid-mismatch" };
    const runtimePid = pids[0] ?? null;
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
