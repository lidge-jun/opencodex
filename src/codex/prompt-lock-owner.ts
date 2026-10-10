import { lstatSync, readFileSync, type Stats } from "node:fs";
import { resolveTrustedWindowsPowerShellExe, resolveTrustedWindowsRegExe } from "../lib/windows-elevation";
import { hostname } from "node:os";

import { LockFileBusy, lockFileOperation } from "./prompt-lock-io";

export interface HostIdentity { hostname: string; machine: string }
export interface OwnerEvidence { pid: number; host?: HostIdentity; processStart?: string }
export interface OwnerDeps {
  isProcessAlive: (pid: number) => boolean | undefined;
  hostIdentity: () => HostIdentity | undefined;
  processStart: (pid: number) => string | undefined;
  lstat: (path: string) => Stats;
  uid: () => number | undefined;
  platform: NodeJS.Platform;
}

function command(args: string[], timeoutMs: number): string | undefined {
  try {
    const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    const value = result.stdout.toString().trim();
    return result.exitCode === 0 && value ? value : undefined;
  } catch { return undefined; }
}
const MACHINE_GUID_KEY = "HKLM\\SOFTWARE\\Microsoft\\Cryptography";
function parseMachineGuid(output: string | undefined): string | undefined {
  const lines = output?.trim().split(/\r?\n/);
  if (lines?.length !== 2 || lines[0]!.trim().toLowerCase() !== "hkey_local_machine\\software\\microsoft\\cryptography") return undefined;
  return /^[ \t]+MachineGuid[ \t]+REG_SZ[ \t]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[ \t]*$/i.exec(lines[1]!)?.[1]?.toLowerCase();
}
/** One lazy identity cache per process; unavailable results are cached too. */
export function createOwnerIdentity({
  platform = process.platform, runCommand = command,
  powerShellExe = resolveTrustedWindowsPowerShellExe,
  regExe = resolveTrustedWindowsRegExe,
  readFile = (path: string) => readFileSync(path, "utf8"),
}: {
  platform?: NodeJS.Platform;
  runCommand?: (args: string[], timeoutMs: number) => string | undefined;
  powerShellExe?: () => string;
  regExe?: () => string;
  readFile?: (path: string) => string;
} = {}): Pick<OwnerDeps, "hostIdentity" | "processStart"> {
  let cachedHost: HostIdentity | undefined;
  let hostRead = false;
  function hostIdentity(): HostIdentity | undefined {
    if (hostRead) return cachedHost;
    hostRead = true;
    let machine: string | undefined;
    try {
      if (platform === "linux") {
        for (const path of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
          try {
            const value = readFile(path).trim();
            if (/^[0-9a-f]{32}$/i.test(value)) { machine = value.toLowerCase(); break; }
          } catch { /* Try the fallback machine-id file. */ }
        }
      }
      else if (platform === "darwin") machine = runCommand(["/usr/sbin/sysctl", "-n", "kern.bootsessionuuid"], 1_000);
      else if (platform === "win32") machine = parseMachineGuid(runCommand([regExe(), "query", MACHINE_GUID_KEY, "/v", "MachineGuid"], 3_000));
      if (machine) cachedHost = { hostname: hostname(), machine };
    } catch { /* Missing identity means no automatic takeover. */ }
    return cachedHost;
  }
  function probeProcessStart(pid: number): string | undefined {
    try {
      if (platform === "linux") {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      }
      if (platform === "darwin") return runCommand(["/bin/ps", "-p", String(pid), "-o", "lstart="], 1_000);
      if (platform === "win32") return runCommand([powerShellExe(), "-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], 1_000);
    } catch { /* Unknown start identity never proves death. */ }
    return undefined;
  }
  let ownStartRead = false;
  let cachedOwnStart: string | undefined;
  function processStart(pid: number): string | undefined {
    // No spawn-free Windows start-time source is available here. Missing start
    // evidence disables only the PID-reuse check, never the live-PID veto.
    if (platform === "win32" && pid === process.pid) return undefined;
    if (pid !== process.pid) return probeProcessStart(pid);
    if (!ownStartRead) { ownStartRead = true; cachedOwnStart = probeProcessStart(pid); }
    return cachedOwnStart;
  }
  return { hostIdentity, processStart };
}
const identity = createOwnerIdentity();
export const ownerDefaults: OwnerDeps = {
  isProcessAlive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ESRCH" ? false : code === "EPERM" ? true : undefined;
    }
  },
  ...identity, lstat: lstatSync,
  uid: () => process.getuid?.(), platform: process.platform,
};
export function ownEvidence(deps: OwnerDeps): OwnerEvidence {
  let host: HostIdentity | undefined, start: string | undefined;
  try { host = deps.hostIdentity(); } catch { /* hostless */ }
  try { start = deps.processStart(process.pid); } catch { /* unknown */ }
  return { pid: process.pid, ...(host ? { host } : {}), ...(start ? { processStart: start } : {}) };
}
export function ownerState(record: OwnerEvidence | null, deps: OwnerDeps): "dead" | "live" | "unsafe" {
  let host: HostIdentity | undefined;
  try { host = deps.hostIdentity(); } catch { return "unsafe"; }
  if (!host || !record?.host || (record.processStart !== undefined && (typeof record.processStart !== "string" || !record.processStart))
    || !Number.isSafeInteger(record.pid) || record.pid <= 0
    || host.hostname !== record.host.hostname || host.machine !== record.host.machine) return "unsafe";
  try {
    // Probe another PID's start only when liveness permits a takeover decision.
    if (deps.isProcessAlive(record.pid) !== false) return "live";
    const start = record.processStart === undefined ? undefined : deps.processStart(record.pid);
    // A reused PID is not permission to remove another process's record.
    if (start !== undefined && start !== record.processStart) return "live";
    return deps.isProcessAlive(record.pid) === false ? "dead" : "live";
  } catch { return "live"; }
}
export function safeNamespace(path: string, kind: "file" | "directory", deps: OwnerDeps, missing = false): boolean {
  try {
    const stat = lockFileOperation(() => deps.lstat(path), deps.platform), uid = deps.uid();
    return !stat.isSymbolicLink() && (kind === "file" ? stat.isFile() : stat.isDirectory())
      && (deps.platform === "win32" || (uid !== undefined && stat.uid === uid));
  } catch (error) {
    if (error instanceof LockFileBusy) throw error;
    return missing && (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}
