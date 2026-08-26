import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isLocalAttestationSecret } from "../lib/local-management-attestation";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import {
  resolveTrustedWindowsPowerShellExe,
  resolveTrustedWindowsSystemDirectory,
} from "../lib/windows-elevation";
import { atomicWriteFile } from "./atomic-write";
import { getConfigDir, hardenConfigDir } from "./paths";

export function getPidPath(): string {
  return join(getConfigDir(), "ocx.pid");
}

export function getRuntimePortPath(): string {
  return join(getConfigDir(), "runtime-port.json");
}

function ensureProcessStateDir(): void {
  const dir = getConfigDir();
  assertNotRealHomeUnderTest(dir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  else hardenConfigDir();
}

export function writePid(pid: number): void {
  ensureProcessStateDir();
  atomicWriteFile(getPidPath(), String(pid));
}

export type RuntimePortState = {
  pid: number;
  port: number;
  hostname?: string;
  /** Per-process proof key; protected by the config directory and never served. */
  attestationSecret?: string;
};

function isValidRuntimePortState(value: unknown): value is RuntimePortState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  const hostnameOk = state.hostname === undefined || typeof state.hostname === "string";
  const attestationOk = state.attestationSecret === undefined || isLocalAttestationSecret(state.attestationSecret);
  return Number.isSafeInteger(state.pid)
    && Number(state.pid) > 0
    && Number.isInteger(state.port)
    && Number(state.port) > 0
    && Number(state.port) <= 65535
    && hostnameOk
    && attestationOk;
}

export function writeRuntimePort(state: RuntimePortState): void {
  ensureProcessStateDir();
  atomicWriteFile(getRuntimePortPath(), JSON.stringify(state, null, 2) + "\n");
}

export function parsePidFile(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const pid = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function readPidFileValue(): number | null {
  try {
    return parsePidFile(readFileSync(getPidPath(), "utf-8"));
  } catch {
    return null;
  }
}

export function readRuntimePort(expectedPid?: number): RuntimePortState | null {
  try {
    const parsed = JSON.parse(readFileSync(getRuntimePortPath(), "utf-8"));
    if (!isValidRuntimePortState(parsed)) return null;
    if (expectedPid !== undefined && parsed.pid !== expectedPid) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function removePid(expectedPid?: number): void {
  if (expectedPid !== undefined && readPidFileValue() !== expectedPid) return;
  try { unlinkSync(getPidPath()); } catch { /* ignore */ }
}

export function removeRuntimePort(expectedPid?: number): void {
  if (expectedPid !== undefined && readRuntimePort(expectedPid) === null) return;
  try { unlinkSync(getRuntimePortPath()); } catch { /* ignore */ }
}

/**
 * Snapshot-guarded stale-state purge. A replacement `ocx start` can publish a
 * fresh record while a liveness probe is in flight, so deletion is authorized
 * only by the exact value observed before that probe.
 */
export function removePidIfValueIs(snapshot: number | null): void {
  if (!existsSync(getPidPath())) return;
  if (readPidFileValue() !== snapshot) return;
  try { unlinkSync(getPidPath()); } catch { /* ignore */ }
}

export function removeRuntimePortIfPidIs(snapshotPid: number | null): void {
  const current = readRuntimePort();
  if ((current?.pid ?? null) !== snapshotPid) return;
  try { unlinkSync(getRuntimePortPath()); } catch { /* ignore */ }
}

export function isOcxStartCommandLine(commandLine: string): boolean {
  const normalized = commandLine.toLowerCase().replace(/\\/g, "/");
  // Keep legacy source launches and npm's in-place Windows rename recognizable:
  // a service wrapper may respawn from `.opencodex-*` during a global update.
  const hasOcxEntrypoint = normalized.includes("src/cli.ts")
    || normalized.includes("src/cli/index.ts")
    || normalized.includes("@bitkyc08/opencodex")
    || /@bitkyc08\/\.opencodex-/.test(normalized)
    || /(?:^|[\s/"'])(?:ocx|opencodex)(?:\.cmd)?(?:$|[\s"'])/.test(normalized);
  return hasOcxEntrypoint && /(?:^|[\s"'])start(?:$|[\s"'])/.test(normalized);
}

/** Avoid spawning WMIC/PowerShell on every short liveness poll. */
const ocxStartProcessCache = new Map<number, boolean>();
let ocxStartProcessSweepCursor = 0;
let ocxStartProcessProbe: (pid: number) => void = pid => { process.kill(pid, 0); };

export function setOcxStartProcessProbeForTests(probe: ((pid: number) => void) | null): void {
  ocxStartProcessProbe = probe ?? (pid => { process.kill(pid, 0); });
}

export function setOcxStartProcessCacheForTests(entries: Iterable<readonly [number, boolean]>): void {
  ocxStartProcessCache.clear();
  for (const [pid, value] of entries) ocxStartProcessCache.set(pid, value);
  ocxStartProcessSweepCursor = 0;
}

export function sweepDeadOcxStartProcessCache(maxProbes = 64): number {
  const pids: number[] = [];
  let removed = 0;
  for (const pid of ocxStartProcessCache.keys()) {
    if (Number.isSafeInteger(pid) && pid > 0) pids.push(pid);
    else if (ocxStartProcessCache.delete(pid)) removed += 1;
  }
  if (pids.length === 0 || maxProbes <= 0) {
    ocxStartProcessSweepCursor = 0;
    return removed;
  }
  const probeCount = Math.min(Math.floor(maxProbes), pids.length);
  const start = ocxStartProcessSweepCursor % pids.length;
  for (let offset = 0; offset < probeCount; offset += 1) {
    const pid = pids[(start + offset) % pids.length]!;
    try {
      ocxStartProcessProbe(pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
      if (ocxStartProcessCache.delete(pid)) removed += 1;
    }
  }
  ocxStartProcessSweepCursor = (start + probeCount) % pids.length;
  return removed;
}

export function ocxStartProcessCacheSizeForTests(): number {
  return ocxStartProcessCache.size;
}

function isLikelyOcxStartProcess(pid: number): boolean {
  const cached = ocxStartProcessCache.get(pid);
  if (cached !== undefined) return cached;
  const commandLine = readProcessCommandLine(pid);
  if (commandLine === undefined) return false;
  const ok = isOcxStartCommandLine(commandLine);
  ocxStartProcessCache.set(pid, ok);
  return ok;
}

export function readPid(): number | null {
  const pidPath = getPidPath();
  if (!existsSync(pidPath)) return null;
  try {
    const raw = readFileSync(pidPath, "utf-8").trim();
    const pid = parsePidFile(raw);
    if (pid === null) return null;
    try {
      process.kill(pid, 0);
      return isLikelyOcxStartProcess(pid) ? pid : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        return isLikelyOcxStartProcess(pid) ? pid : null;
      }
      return null;
    }
  } catch {
    return null;
  }
}

/**
 * Cheap non-destructive liveness check. Destructive callers must additionally
 * call `verifyPidIdentity()` before acting on the returned PID.
 */
export function readAlivePid(): number | null {
  const pid = readPidFileValue();
  if (pid === null) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return pid;
    return null;
  }
}

/**
 * Full identity check for a known candidate. The returned PID must equal the
 * candidate, preventing a pidfile rewrite from swapping in another process.
 */
export function verifyPidIdentity(candidatePid: number): number | null {
  try {
    process.kill(candidatePid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return null;
  }
  return isLikelyOcxStartProcess(candidatePid) ? candidatePid : null;
}

type ProcessCommandLineExec = (
  executable: string,
  args: string[],
  options: {
    encoding: BufferEncoding;
    stdio: ["ignore", "pipe", "ignore"];
    timeout: number;
    windowsHide: boolean;
  },
) => string;

const defaultProcessCommandLineExec: ProcessCommandLineExec = (executable, args, options) =>
  execFileSync(executable, args, options);
let processCommandLineExec = defaultProcessCommandLineExec;
let processCommandLinePlatformForTests: NodeJS.Platform | null = null;

export function setProcessCommandLineExecForTests(next: ProcessCommandLineExec | null): void {
  processCommandLineExec = next ?? defaultProcessCommandLineExec;
}

export function setProcessCommandLinePlatformForTests(next: NodeJS.Platform | null): void {
  processCommandLinePlatformForTests = next;
}

function readProcessCommandLine(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const platform = processCommandLinePlatformForTests ?? process.platform;
  try {
    if (platform === "linux") {
      try {
        const output = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
        const value = output.replace(/\0/g, " ").trim();
        if (value) return value;
      } catch {
        /* procfs unavailable — use the fixed ps fallback below */
      }
    }
    if (platform === "win32") {
      // WMIC is the fast path. Newer Windows images may omit it, so fall back to
      // the trusted fixed PowerShell binary without consulting PATH or env roots.
      const wmic = join(resolveTrustedWindowsSystemDirectory(), "wbem", "WMIC.exe");
      try {
        const output = processCommandLineExec(wmic, [
          "process", "where", `ProcessId=${pid}`, "get", "CommandLine", "/VALUE",
        ], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000, windowsHide: true });
        const match = /^CommandLine=(.*)$/m.exec(output.replace(/\r/g, ""));
        const value = match?.[1]?.trim();
        if (value) return value;
      } catch {
        /* WMIC missing or failed — fall through */
      }
      const output = processCommandLineExec(resolveTrustedWindowsPowerShellExe(), [
        "-NoProfile",
        "-NoLogo",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
      ], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000, windowsHide: true });
      return output.trim() || undefined;
    }
    for (const ps of ["/bin/ps", "/usr/bin/ps"]) {
      try {
        const output = processCommandLineExec(ps, ["-p", String(pid), "-o", "command="], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 1000,
          windowsHide: true,
        });
        const value = output.trim();
        if (value) return value;
      } catch {
        /* try the other fixed system path */
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}
